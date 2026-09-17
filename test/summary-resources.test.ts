import assert from "node:assert/strict";
import { test } from "node:test";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { assistant } from "./helpers.ts";
import { sdkFixture, waitFor } from "./sdk-helper.ts";

test("a background summary releases its own transport, not the parent session's resources", async (t) => {
  const cleaned: (string | undefined)[] = [];
  const unregister = registerSessionResourceCleanup((id) => cleaned.push(id));
  let summaryId: string | undefined;
  const f = await sdkFixture(
    t,
    () => assistant(),
    (_context, options) => {
      summaryId = options?.sessionId;
      return assistant("stop", "本轮记录已保存。");
    },
  );
  f.cleanup(unregister);
  await f.session.prompt("Check isolated summary resources");
  await waitFor(() => !!f.archive.getRun("r1").overview);
  assert.ok(summaryId);
  assert.notEqual(summaryId, f.session.sessionId);
  assert.ok(cleaned.includes(summaryId));
  assert.ok(!cleaned.includes(undefined));
  assert.ok(!cleaned.includes(f.session.sessionId));
  f.checkErrors();
});

test("the bounded summary queue reports overflow and cancellation releases the in-flight transport", async (t) => {
  const cleaned: (string | undefined)[] = [];
  const unregister = registerSessionResourceCleanup((id) => cleaned.push(id));
  let summaryId: string | undefined;
  const f = await sdkFixture(
    t,
    () => assistant(),
    (_context, options) => {
      summaryId = options?.sessionId;
      return new Promise(() => {});
    },
  );
  f.cleanup(unregister);
  for (let i = 0; i < 9; i++) await f.session.prompt(`task ${i}`);
  assert.match(f.archive.getRun("r9").summaryError ?? "", /队列已满/);
  assert.equal(f.archive.getRun("r9").recording, false);
  assert.equal(f.summaryRequests.length, 1);
  await f.shutdown();
  assert.ok(summaryId && cleaned.includes(summaryId));
  f.checkErrors();
});
