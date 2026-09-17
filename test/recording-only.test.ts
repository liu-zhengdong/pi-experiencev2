import assert from "node:assert/strict";
import { test } from "node:test";
import { Archive } from "../src/archive.ts";
import { parse } from "../src/data.ts";
import { RunStore } from "../src/store.ts";
import { summaryContext } from "../src/summary.ts";
import { assistant, finishRun, recording } from "./helpers.ts";
import { sdkFixture, waitFor } from "./sdk-helper.ts";

const badges =
  /已收束|进行中|已中止|结束待确认|recovery_required|completed|interrupted|failed|running|尚未确认|未确认结束/;

test("legacy outcomes produce identical status-free reading and summary inputs without rewriting history", async (t) => {
  const f = recording(t);
  const id = finishRun(
    f.recorder,
    "核对索引",
    assistant("stop", "已检查代码，验证尚待执行。"),
  );
  f.store.db
    .prepare("UPDATE runs SET ended_at=NULL, reason='legacy-reason' WHERE id=?")
    .run(id);
  const readRows = () => ({
    run: f.store.db.prepare("SELECT * FROM runs WHERE id=?").get(id),
    messages: f.store.messages(f.sessionId, id),
    events: f.store.events(f.sessionId, id),
  });
  const reopen = new RunStore(f.path);
  f.cleanup(() => reopen.close());
  const archive = new Archive(reopen);
  const expectedPage = await archive.find({ id: "r1" });
  const expectedSummary = summaryContext(archive, "r1");
  for (const state of [
    "completed",
    "failed",
    "interrupted",
    "recovery_required",
  ]) {
    f.store.db.prepare("UPDATE runs SET status=? WHERE id=?").run(state, id);
    const before = readRows();
    assert.deepEqual(await archive.find({ id: "r1" }), expectedPage);
    assert.deepEqual(summaryContext(archive, "r1"), expectedSummary);
    const listing = await archive.find();
    assert.deepEqual(
      listing.choices.map((c) => c.id),
      ["r1"],
    );
    assert.doesNotMatch(listing.text + listing.displayText, badges);
    assert.doesNotMatch(expectedPage.text + expectedPage.displayText, badges);
    assert.equal(archive.getRun("r1").recording, false);
    assert.equal("status" in archive.getRun("r1"), false);
    assert.equal("reason" in archive.getRun("r1"), false);
    assert.deepEqual(readRows(), before, "reading must not normalize old rows");
  }
  assert.doesNotMatch(
    JSON.stringify(expectedSummary),
    /Run状态|recovery_required|completed只表示/,
  );
  assert.equal(reopen.db.prepare("PRAGMA user_version").get()?.user_version, 1);
});

test("status words in historical summaries and original messages are evidence, not text to strip", async (t) => {
  const f = recording(t);
  const source = "旧工具返回 status=failed；页面显示已收束。";
  const id = finishRun(f.recorder, "核对旧记录", assistant("error", source));
  f.store.db
    .prepare("UPDATE runs SET overview='旧摘要：执行已收束' WHERE id=?")
    .run(id);
  const page = await f.archive.find({ id: "r1" });
  assert.match(page.text, /旧摘要：执行已收束/);
  const message = page.choices.at(-1)?.id;
  assert.ok(message);
  assert.match(
    f.archive.detail({ id: message }).text,
    /status=failed；页面显示已收束/,
  );
  assert.doesNotMatch(page.displayText.split("\n")[0] ?? "", badges);
});

test("recording guard still blocks summary and atomic deletion until real SDK settlement", async (t) => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = await sdkFixture(
    t,
    async () => {
      entered.resolve();
      await release.promise;
      return assistant();
    },
    () => assistant("stop", "消息已保存。"),
  );
  f.cleanup(() => release.resolve());
  const work = f.session.prompt("录制中的请求");
  await entered.promise;
  assert.equal(f.archive.getRun("r1").recording, true);
  assert.deepEqual((await f.archive.find()).choices, []);
  const page = await f.archive.find({ id: "r1" });
  assert.match(page.text, /录制中的请求/);
  assert.doesNotMatch(page.text + page.displayText, badges);
  await f.session.prompt("/runs summary r1");
  assert.equal(f.summaryRequests.length, 0);
  assert.throws(
    () => f.archive.deleteRuns(["r1"], "用户授权清理测试记录"),
    /Active Run/,
  );
  release.resolve();
  await work;
  await waitFor(() => !!f.archive.getRun("r1").overview);
  assert.equal(f.archive.getRun("r1").recording, false);
  assert.equal(f.summaryRequests.length, 1);
  f.checkErrors();
});

test("invalid stored recording markers fail closed and malformed JSON remains an explicit error", (t) => {
  const f = recording(t);
  const id = finishRun(f.recorder);
  f.store.db.exec("PRAGMA ignore_check_constraints=ON");
  f.store.db.prepare("UPDATE runs SET status='unknown' WHERE id=?").run(id);
  assert.throws(() => f.archive.getRun(id), /Invalid stored recording marker/);
  assert.throws(
    () => f.archive.deleteRuns([id], "用户授权测试"),
    /Invalid stored recording marker/,
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM messages").get()?.n,
    2,
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM deleted_runs").get()?.n,
    0,
  );
  assert.throws(() => parse("{invalid"), /Invalid archived JSON/);
  assert.deepEqual(parse('{"items":[null,true,1,"text"]}'), {
    items: [null, true, 1, "text"],
  });
});
