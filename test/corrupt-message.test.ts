import assert from "node:assert/strict";
import { test } from "node:test";
import { finishRun, recording } from "./helpers.ts";

test("corrupt message data fails explicitly with its ID; raw bytes remain readable", async (t) => {
  const f = recording(t);
  finishRun(f.recorder);
  const ref = (await f.archive.find({ id: "r1" })).choices[0]?.id;
  assert.ok(ref);
  f.store.db.exec("PRAGMA ignore_check_constraints = ON");
  for (const payload of [
    "{broken JSON",
    "null",
    '{"content":"missing role"}',
  ]) {
    f.store.db
      .prepare("UPDATE messages SET payload=? WHERE first_seq=?")
      .run(payload, Number(ref.slice(1)));
    const error = new RegExp(`Invalid archived message ${ref}`);
    await assert.rejects(
      f.archive.find({ query: "missing", scope: "content" }),
      error,
    );
    await assert.rejects(f.archive.find({ id: "r1" }), error);
    assert.throws(() => f.archive.detail({ id: ref }), error);
    assert.equal(
      f.archive.detail({ id: ref, format: "raw" }).displayText,
      payload,
    );
  }
});
