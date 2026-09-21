import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Archive, type FindArgs } from "../src/archive.ts";
import { integer, text } from "../src/data.ts";
import { RunRecorder } from "../src/recorder.ts";
import { RunStore } from "../src/store.ts";
import {
  assistant,
  finishRun,
  ordinalOf,
  recording,
  workspace,
} from "./helpers.ts";

test("archive search covers summaries, full text, metadata and exact time/directory filters", async (t) => {
  const f = recording(t);
  const id = finishRun(
    f.recorder,
    "实现数据库索引",
    assistant("stop", "修好SQLITE外键，确认等待处理。"),
  );
  f.store.db
    .prepare(
      "UPDATE runs SET overview='补上归档外键索引', started_at='2026-09-15T01:00:00.000Z' WHERE id=?",
    )
    .run(id);
  for (const query of ["归档 索引", "SQLITE 确认", "数据库", "实现"])
    assert.equal((await f.archive.find({ query })).choices.length, 1);
  assert.equal(
    (await f.archive.find({ query: "SQLITE", scope: "summary" })).choices
      .length,
    0,
  );
  assert.equal(
    (await f.archive.find({ cwd: `${f.directory}/other` })).choices.length,
    0,
  );
  assert.equal(
    (
      await f.archive.find({
        cwd: f.directory,
        since: "2026-09-15T09:00:00+08:00",
        until: "2026-09-15T01:00:01Z",
      })
    ).choices.length,
    1,
  );
  assert.equal(
    (await f.archive.find({ until: "2026-09-15T01:00:00Z" })).choices.length,
    0,
  );
  const hit = await f.archive.find({ query: "SQLITE", scope: "content" });
  assert.match(hit.text, /命中 r1\/m2 · /);
  assert.equal(
    (await f.archive.find({ query: '"SQLITE外键"', scope: "content" })).choices
      .length,
    1,
  );
  assert.equal(
    (await f.archive.find({ query: '"SQLITE 外键"', scope: "content" })).choices
      .length,
    0,
  );
  assert.equal(f.archive.getRun("r1").id, id);
  assert.match(
    (await f.archive.find({ id: "r1" })).text,
    /user[\s\S]*assistant/,
  );
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test("search OR matches either alternative; AND, lowercase or and bad syntax stay strict", async (t) => {
  const f = recording(t);
  const a = finishRun(f.recorder, "alpha", assistant("stop", "完全不认可"));
  const b = finishRun(f.recorder, "beta", assistant("stop", "先确认再落盘"));
  f.store.db
    .prepare("UPDATE runs SET overview=? WHERE id=?")
    .run("用户否定心跳方案", a);
  f.store.db
    .prepare("UPDATE runs SET overview=? WHERE id=?")
    .run("确认思路后落盘", b);
  const ids = async (query: string, scope?: "summary" | "content") =>
    (await f.archive.find({ query, ...(scope ? { scope } : {}) })).choices.map(
      (c) => c.id,
    );
  assert.deepEqual(await ids("不认可 OR 落盘", "content"), ["r2", "r1"]);
  assert.deepEqual(await ids("否定 OR 落盘", "summary"), ["r2", "r1"]);
  assert.deepEqual(await ids("不认可 落盘", "content"), []);
  assert.deepEqual(await ids("不认可 or 落盘", "content"), []);
  for (const query of ["foo OR", '"unterminated', '"foo"bar'])
    await assert.rejects(f.archive.find({ query }), /OR|quote|phrase/i, query);
});

test("search rejects misleading matches in attachments, reasoning, tool args and across text blocks", async (t) => {
  const f = recording(t);
  finishRun(f.recorder, "source", {
    ...assistant(),
    content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "thinking", thinking: "hidden-needle" },
      {
        type: "toolCall",
        id: "c",
        name: "read",
        arguments: { path: "args-needle" },
      },
    ],
  });
  // Add an image to the user message through the recorder in another Run.
  f.recorder.capture({ type: "agent_start" });
  const message = {
    role: "user" as const,
    timestamp: 1,
    content: [
      {
        type: "image" as const,
        data: "attachment-needle",
        mimeType: "image/png",
      },
    ],
  };
  f.recorder.capture({ type: "message_end", message });
  f.recorder.capture({ type: "message_end", message: assistant() });
  f.recorder.capture({ type: "agent_settled" });
  for (const query of [
    "hidden-needle",
    "attachment-needle",
    "args-needle",
    "first second",
  ])
    assert.equal(
      (await f.archive.find({ query, scope: "content" })).choices.length,
      0,
      query,
    );
  assert.equal(
    (await f.archive.find({ query: "first OR second", scope: "content" }))
      .choices.length,
    1,
  );
  for (const args of [
    { scope: "content", query: " " },
    { since: "yesterday" },
    { since: "2026-02-31T00:00:00Z" },
    { since: "2026-09-15T01:00:00Z", until: "2026-09-15T00:00:00Z" },
    { limit: 0 },
    { limit: 51 },
    { id: "r1", query: "first" },
  ])
    await assert.rejects(f.archive.find(args as FindArgs));
});

test("all pages preserve order; forged, changed-query and restart cursors are rejected", async (t) => {
  const f = recording(t);
  for (let i = 0; i < 7; i++) finishRun(f.recorder, `work ${i}`);
  let args: FindArgs | undefined = { limit: 2 };
  const found: string[] = [];
  const initial = await f.archive.find(args);
  assert.ok(initial.next);
  while (args) {
    const page = await f.archive.find(args);
    found.push(...page.choices.map((c) => c.id));
    args = page.next;
  }
  assert.deepEqual(found, ["r7", "r6", "r5", "r4", "r3", "r2", "r1"]);
  await assert.rejects(
    f.archive.find({ ...initial.next, query: "changed" }),
    /cursor/,
  );
  await assert.rejects(
    f.archive.find({ ...initial.next, cursor: `${initial.next.cursor}bad` }),
    /cursor/,
  );
  await assert.rejects(new Archive(f.store).find(initial.next), /cursor/);
  const first = await f.archive.find({ id: "r1", limit: 1 });
  assert.ok(first.next);
  const second = await f.archive.find(first.next);
  assert.match(first.text, /user/);
  assert.match(second.text, /assistant/);
  assert.equal(second.next, undefined);
  f.recorder.capture({ type: "agent_start" });
  assert.equal(
    (await f.archive.find()).choices.length,
    7,
    "active Run is not listed",
  );
});

test("message detail pagination is lossless for emoji, text, reasoning, tool JSON and raw attachments", async (t) => {
  const f = recording(t),
    source = "🧪中文\n".repeat(10_000);
  const id = finishRun(f.recorder, source, {
    ...assistant(),
    content: [
      { type: "thinking", thinking: "思考详情" },
      { type: "text", text: "最终回答" },
    ],
  });
  const messages = await f.archive.find({ id });
  const ref = messages.choices[0]?.id;
  assert.ok(ref);
  assert.equal(ref, "r1/m1");
  const expectedRow = f.store.db
    .prepare(
      "SELECT payload, dict_id FROM messages WHERE run_ref=? ORDER BY first_seq LIMIT 1",
    )
    .get(ordinalOf(f.store, id));
  const expectedRaw = f.store.payloadText(
    expectedRow?.payload,
    expectedRow?.dict_id,
  );
  for (const format of ["text", "raw"] as const) {
    let args:
      | { id: string; format: "text" | "raw"; cursor?: string }
      | undefined = { id: ref, format };
    let output = "",
      count = 0;
    while (args) {
      const page = f.archive.detail(args);
      const body = page.text.slice(
        page.text.indexOf("\n---\n") + 5,
        page.text.lastIndexOf("\n---\n"),
      );
      assert.ok(Buffer.byteLength(body) <= 12_000);
      assert.ok(!/[\uD800-\uDBFF]$/u.test(body));
      output += body;
      args = page.next as typeof args;
      count++;
    }
    assert.ok(count > 2);
    assert.equal(output, format === "raw" ? expectedRaw : source);
  }
  assert.match(
    f.archive.detail({ id: messages.choices[1]?.id ?? "" }).text,
    /思考详情[\s\S]*最终回答/,
  );
  const page = f.archive.detail({ id: ref });
  assert.ok(page.next);
  assert.throws(
    () => f.archive.detail({ ...page.next, id: ref, format: "raw" }),
    /cursor/,
  );
});

test("message refs are run-scoped and reset per run; legacy global refs and UUIDs still resolve", async (t) => {
  const f = recording(t);
  const one = finishRun(f.recorder, "第一轮", assistant("stop", "第一轮回答"));
  const two = finishRun(f.recorder, "第二轮", assistant("stop", "第二轮回答"));
  assert.deepEqual(
    (await f.archive.find({ id: one })).choices.map((c) => c.id),
    ["r1/m1", "r1/m2"],
  );
  assert.deepEqual(
    (await f.archive.find({ id: two })).choices.map((c) => c.id),
    ["r2/m1", "r2/m2"],
  );
  assert.match(
    (await f.archive.find({ query: "第二轮回答", scope: "content" })).text,
    /命中 r2\/m2 · /,
  );
  // Same position in different Runs resolves to that Run's own message.
  assert.match(f.archive.detail({ id: "r1/m2" }).text, /第一轮回答/);
  assert.match(f.archive.detail({ id: "r2/m2" }).text, /第二轮回答/);
  // Legacy global m-number and UUID resolve to the same message body.
  const stored = f.store.db
    .prepare(
      "SELECT id, first_seq FROM messages WHERE run_ref=? ORDER BY first_seq LIMIT 1 OFFSET 1",
    )
    .get(ordinalOf(f.store, one));
  assert.ok(stored);
  const body = (page: string) => page.slice(page.indexOf("\n---\n"));
  assert.equal(
    body(f.archive.detail({ id: `m${integer(stored, "first_seq")}` }).text),
    body(f.archive.detail({ id: "r1/m2" }).text),
  );
  assert.match(f.archive.detail({ id: text(stored, "id") }).text, /第一轮回答/);
  // Out-of-range positions, unknown Runs and malformed refs are rejected.
  for (const id of ["r1/m3", "r9/m1", "r1/m0", "r0/m1", "m0"])
    assert.throws(() => f.archive.detail({ id }), /not found/i, id);
});

test("deletion is atomic, idempotent and bounded; neither live Runs nor unknown IDs can be mixed into a batch", async (t) => {
  const f = recording(t),
    one = finishRun(f.recorder),
    two = finishRun(f.recorder);
  f.recorder.capture({ type: "agent_start" });
  const active = f.recorder.runRef;
  assert.ok(active);
  const before = JSON.stringify(f.store.db.prepare("SELECT * FROM runs").all());
  for (const ids of [[one, `r${active}`], [one, "missing"], []])
    assert.throws(() => f.archive.deleteRuns(ids, "用户要求清理测试"));
  assert.throws(() => f.archive.deleteRuns([one], " "));
  assert.equal(
    JSON.stringify(f.store.db.prepare("SELECT * FROM runs").all()),
    before,
  );
  const messageRef = (await f.archive.find({ id: one })).choices[0]?.id;
  assert.ok(messageRef);
  f.store.db.exec(
    "CREATE TRIGGER fail_delete BEFORE DELETE ON runs WHEN OLD.ordinal=2 BEGIN SELECT RAISE(ABORT,'simulated delete failure'); END;",
  );
  assert.throws(
    () => f.archive.deleteRuns([one, two], "用户授权"),
    /simulated delete failure/,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS n FROM messages WHERE run_ref=?")
      .get(ordinalOf(f.store, one))?.n,
    2,
  );
  const ordinals = [ordinalOf(f.store, one), ordinalOf(f.store, two)];
  f.store.db.exec("DROP TRIGGER fail_delete");
  assert.deepEqual(f.archive.deleteRuns([one, "r1", two], "用户授权"), {
    deleted: ["r1", "r2"],
    alreadyDeleted: [],
  });
  assert.deepEqual(f.archive.deleteRuns([one, "r2"], "再次清理"), {
    deleted: [],
    alreadyDeleted: [one, "r2"],
  });
  assert.throws(() => f.archive.getRun(one), /已被删除/);
  assert.throws(() => f.archive.detail({ id: messageRef }), /deleted/);
  for (const table of ["messages", "events"])
    assert.equal(
      f.store.db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE run_ref IN (?,?)`)
        .get(ordinals[0] ?? 0, ordinals[1] ?? 0)?.n,
      0,
    );
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
  f.recorder.capture({ type: "message_end", message: assistant() });
  f.recorder.capture({ type: "agent_settled" });
  const next = finishRun(f.recorder);
  assert.equal(f.archive.getRun(next).ordinal, 4);
});

test("v1/foreign/future databases are rejected without changing bytes or journal mode", (t) => {
  const f = workspace(t);
  for (const version of [0, 5]) {
    const path = `${f.path}.${version}`,
      db = new DatabaseSync(path);
    db.exec(
      `CREATE TABLE experiences (body TEXT); INSERT INTO experiences VALUES ('old evidence'); PRAGMA user_version=${version};`,
    );
    db.close();
    const hash = () =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    const before = hash();
    assert.throws(() => new RunStore(path), /separate empty database/);
    assert.equal(hash(), before);
    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      check.prepare("PRAGMA journal_mode").get()?.journal_mode,
      "delete",
    );
    check.close();
  }
});

test("single-writer ownership and branch isolation apply to every kind of recorded outcome", (t) => {
  const f = recording(t),
    another = new RunStore(f.path);
  f.cleanup(() => another.close());
  assert.throws(
    () =>
      new RunRecorder(another, "pi", {
        piSessionId: "test-session",
        cwd: f.directory,
        title: null,
        reason: "resume",
      }),
    /live writer/,
  );
  for (const stop of ["stop", "error", "length", "aborted"] as const) {
    const message = assistant(stop);
    const id = finishRun(f.recorder, "test", message);
    assert.equal(f.archive.getRun(id).recording, false);
    assert.ok(f.archive.getRun(id).endedAt);
    assert.deepEqual(
      f.store.messages(f.sessionRef, ordinalOf(f.store, id)).at(-1)?.payload,
      message,
    );
  }
  const before = f.recorder.binding.branchRef;
  f.recorder.capture({
    type: "session_tree",
    newLeafId: "old-tree-entry",
    oldLeafId: "current",
    fromExtension: false,
  });
  assert.notEqual(f.recorder.binding.branchRef, before);
  const id = finishRun(f.recorder);
  assert.equal(f.archive.getRun(id).branchRef, f.recorder.binding.branchRef);
});
