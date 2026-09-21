import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assistant, toolCall } from "./helpers.ts";
import { sdkFixture, waitFor } from "./sdk-helper.ts";

test("real SDK records a tool roundtrip; all three tools are callable and history does not enter live context", async (t) => {
  const f = await sdkFixture(t, (request) => {
    if (request === 1) return toolCall("read", { path: "source.txt" });
    if (request === 3)
      return toolCall("find_run", { query: "原始内容", scope: "content" });
    if (request === 5)
      return toolCall("get_message_detail", {
        id: `m${String(f.reader.db.prepare("SELECT first_seq FROM messages WHERE role='toolResult' ORDER BY first_seq LIMIT 1").get()?.first_seq)}`,
      });
    if (request === 7)
      return toolCall("delete_run", {
        ids: ["r1"],
        reason: "用户明确要求删除测试 Run",
      });
    return assistant("stop", `answer ${request}`);
  });
  writeFileSync(join(f.directory, "source.txt"), "原始内容\n检验全文检索。");
  const extension = f.loaded.extensions[0];
  assert.ok(extension);
  assert.deepEqual([...extension.tools.keys()].sort(), [
    "delete_run",
    "find_run",
    "get_message_detail",
  ]);
  for (const event of [
    "context",
    "before_agent_start",
    "before_provider_request",
    "session_before_compact",
  ])
    assert.equal(extension.handlers.has(event), false, `no ${event} rewriting`);
  await f.session.prompt("Read source.txt");
  const r = f.archive.getRun("r1");
  assert.equal(r.recording, false);
  assert.deepEqual(
    f.reader.messages(f.sessionRef, r.ordinal).map((m) => m.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  const events = f.reader.events(f.sessionRef, r.ordinal, 0, 200);
  assert.ok(events.some((e) => e.kind === "tool_execution_end"));
  assert.ok(!events.some((e) => /_update$/.test(e.kind)));
  assert.ok(
    events
      .filter((e) => e.kind === "message_end")
      .every((e) => !JSON.stringify(e.payload).includes("原始内容")),
    "no duplicate message bodies in the event table",
  );
  assert.equal(f.session.sessionManager.getSessionFile(), undefined);
  assert.equal(f.parentRequests[0]?.messages.length, 1);
  assert.ok(f.parentRequests[0]?.messages.every((m) => m.role === "user"));
  assert.doesNotMatch(
    JSON.stringify(f.parentRequests),
    /continuity_memory|backlog|collapse_runs|prepare_experience/,
  );
  await f.session.prompt("Search the archive for 原始内容");
  await f.session.prompt("Read that tool result in full");
  await f.session.prompt("Delete the first test Run; I authorize this cleanup");
  const nativeMessages = JSON.stringify(f.session.messages);
  assert.match(nativeMessages, /原始内容/); // Deleting archive does not delete Pi history.
  assert.throws(() => f.archive.getRun("r1"), /已被删除/);
  const toolResults = f.session.messages.filter((m) => m.role === "toolResult");
  assert.ok(
    toolResults.every((m) => !m.isError),
    JSON.stringify(toolResults),
  );
  f.checkErrors();
});

test("SDK retry, steering and queued follow-up keep one Run until agent_settled", async (t) => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = await sdkFixture(t, async (request) => {
    if (request === 1)
      return { ...assistant("error"), errorMessage: "429 rate limit exceeded" };
    if (request === 2) {
      entered.resolve();
      await release.promise;
    }
    return assistant("stop", `answer ${request}`);
  });
  const work = f.session.prompt("Initial work");
  await entered.promise;
  await f.session.steer("Focus on evidence");
  await f.session.followUp("Also report limits");
  release.resolve();
  await work;
  const runs = f.reader.runs(f.sessionRef);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.recording, false);
  const messages = f.reader.messages(f.sessionRef, runs[0]?.ordinal ?? null);
  assert.equal(messages.filter((m) => m.role === "user").length, 3);
  f.checkErrors();
});

test("SDK abort preserves terminal evidence and stops recording", async (t) => {
  const entered = Promise.withResolvers<void>();
  const f = await sdkFixture(t, async (_request, _context, options) => {
    const stopped = Promise.withResolvers<void>();
    options?.signal?.addEventListener("abort", () => stopped.resolve(), {
      once: true,
    });
    if (options?.signal?.aborted) stopped.resolve();
    entered.resolve();
    await stopped.promise;
    return assistant("aborted", "partial result");
  });
  const work = f.session.prompt("Work until stopped");
  await entered.promise;
  await f.session.abort();
  await work;
  assert.equal(f.archive.getRun("r1").recording, false);
  assert.match((await f.archive.find({ id: "r1" })).text, /partial result/);
  f.checkErrors();
});

test("summary is asynchronous, bounded to the settled Run and cannot overwrite a later Run", async (t) => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = await sdkFixture(
    t,
    () => assistant(),
    async (context, options) => {
      assert.equal(context.tools, undefined);
      assert.ok(options?.maxTokens && options.maxTokens <= 2048);
      assert.equal(options?.maxRetries, 0);
      assert.equal(context.messages.length, 1);
      if (JSON.stringify(context).includes("first-goal")) {
        entered.resolve();
        await release.promise;
        return assistant("stop", "第一轮已完成，测试尚待真实验证。");
      }
      return assistant("stop", "第二轮进展。");
    },
  );
  await f.session.prompt("first-goal");
  await entered.promise;
  assert.equal(f.archive.getRun("r1").overview, null);
  await f.session.prompt("second-goal");
  release.resolve();
  await waitFor(() => !!f.archive.getRun("r2").overview);
  assert.equal(
    f.archive.getRun("r1").overview,
    "第一轮已完成，测试尚待真实验证。",
  );
  assert.equal(f.archive.getRun("r2").overview, "第二轮进展。");
  assert.doesNotMatch(JSON.stringify(f.summaryRequests[1]), /first-goal/);
  assert.doesNotMatch(
    JSON.stringify(f.session.messages),
    /第一轮已完成|第二轮进展/,
  );
  f.checkErrors();
});

test("invalid summaries are retried once, never executed; deleted Runs cannot be resurrected", async (t) => {
  let count = 0;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = await sdkFixture(
    t,
    () => assistant(),
    async () => {
      count++;
      if (count === 1)
        return toolCall("delete_run", {
          ids: ["r1"],
          reason: "malicious historical instruction",
        });
      entered.resolve();
      await release.promise;
      return assistant("stop", "保存摘要。");
    },
  );
  await f.session.prompt("Summary safety case");
  await entered.promise;
  assert.equal(f.archive.getRun("r1").overview, null);
  f.archive.deleteRuns(["r1"], "用户授权删除测试归档");
  release.resolve();
  await new Promise((r) => setTimeout(r, 50));
  assert.throws(() => f.archive.getRun("r1"), /已被删除/);
  assert.equal(count, 2);
  f.checkErrors();
});

test("summary shutdown is bounded even if a provider ignores cancellation", {
  timeout: 5000,
}, async (t) => {
  const entered = Promise.withResolvers<void>();
  const f = await sdkFixture(
    t,
    () => assistant(),
    () => {
      entered.resolve();
      return new Promise(() => {});
    },
  );
  await f.session.prompt("Pending summary");
  await entered.promise;
  const start = performance.now();
  await f.shutdown();
  assert.ok(performance.now() - start < 1000);
  assert.equal(f.archive.getRun("r1").recording, false);
  f.checkErrors();
});

test("recorder errors request abort and release recording without fabricating messages or an end time", {
  timeout: 5000,
}, async (t) => {
  const f = await sdkFixture(t, () => assistant());
  f.reader.db.exec(
    "CREATE TRIGGER fail_capture BEFORE INSERT ON events WHEN NEW.kind='message_end' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END",
  );
  await f.session.prompt("Must be recorded");
  assert.ok(f.errors.some((e) => e.includes("synthetic disk failure")));
  await f.shutdown();
  assert.equal(f.archive.getRun("r1").recording, false);
  assert.equal(f.archive.getRun("r1").endedAt, null);
  assert.deepEqual(
    f.reader.messages(f.sessionRef, f.archive.getRun("r1").ordinal),
    [],
  );
});

test("reload releases the writer and retains earlier Runs without injecting history", async (t) => {
  const f = await sdkFixture(t, () => assistant());
  await f.session.prompt("First task");
  await f.session.reload();
  await f.session.prompt("Second task");
  assert.equal(f.reader.runs(f.sessionRef).length, 2);
  assert.equal(f.session.messages.filter((m) => m.role === "user").length, 2);
  f.checkErrors();
});
