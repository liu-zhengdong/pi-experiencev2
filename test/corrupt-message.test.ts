import assert from "node:assert/strict";
import { test } from "node:test";
import { Archive } from "../src/archive.ts";
import { text } from "../src/data.ts";
import { finishRun, recording } from "./helpers.ts";

test("corrupt message data fails explicitly with its ID; raw bytes remain readable", async (t) => {
  const f = recording(t);
  finishRun(f.recorder);
  const ref = (await f.archive.find({ id: "r1" })).choices[0]?.id;
  assert.ok(ref);
  const row = f.store.db
    .prepare("SELECT id FROM messages ORDER BY first_seq LIMIT 1")
    .get();
  assert.ok(row);
  const messageId = text(row, "id");
  f.store.db.exec("PRAGMA ignore_check_constraints = ON");
  // Raw JSON that does not parse, and bytes that are not a valid compressed
  // frame, are both unreadable and must report the same way.
  for (const [payload, dictId] of [
    ["{broken JSON", null],
    ["null", null],
    ['{"content":"missing role"}', null],
    ["not a zstd frame at all", 0],
  ] as const) {
    f.store.db
      .prepare("UPDATE messages SET payload=?, dict_id=? WHERE id=?")
      .run(Buffer.from(payload, "utf8"), dictId, messageId);
    // This test rewrites one message in place, which the archive otherwise
    // forbids; a fresh reader avoids the projection cache built for immutable
    // messages reporting the previous corruption.
    const archive = new Archive(f.store);
    const error = new RegExp(`Invalid archived message ${ref}`);
    await assert.rejects(
      archive.find({ query: "missing", scope: "content" }),
      error,
    );
    await assert.rejects(archive.find({ id: "r1" }), error);
    assert.throws(() => archive.detail({ id: ref }), error);
    assert.equal(
      archive.detail({ id: ref, format: "raw" }).displayText,
      payload,
    );
  }
});
