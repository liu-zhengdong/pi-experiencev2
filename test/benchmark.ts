// Synthetic scale check, no production database writes or model calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive, type FindArgs } from "../src/archive.ts";
import { RunRecorder } from "../src/recorder.ts";
import { RunStore } from "../src/store.ts";
import { assistant } from "./helpers.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-runs-scale-")),
  path = join(directory, "scale.sqlite");
const store = new RunStore(path),
  archive = new Archive(store);
const recorder = new RunRecorder(store, "pi", {
  piSessionId: "scale",
  cwd: directory,
  title: null,
  reason: "test",
});
const started = performance.now();
for (let i = 0; i < 1000; i++) {
  recorder.capture({ type: "agent_start" });
  recorder.capture({
    type: "message_end",
    message: { role: "user", content: `task ${i}`, timestamp: i },
  });
  for (let j = 0; j < 24; j++)
    recorder.capture({
      type: "message_end",
      message: assistant(
        "stop",
        `task ${i} message ${j}\n${"sample evidence\n".repeat(500)}${i === 0 && j === 0 ? "rare-needle" : ""}`,
      ),
    });
  recorder.capture({ type: "agent_settled" });
}
store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const writeMs = performance.now() - started;
async function scan(initial: FindArgs) {
  let args: FindArgs | undefined = initial,
    pages = 0,
    hits = 0,
    maxPageMs = 0;
  const started = performance.now();
  while (args) {
    const at = performance.now();
    const page = await archive.find(args);
    maxPageMs = Math.max(maxPageMs, performance.now() - at);
    pages++;
    hits += page.choices.length;
    args = page.next;
  }
  return { pages, hits, totalMs: performance.now() - started, maxPageMs };
}
const absent = await scan({ query: "definitely-missing", scope: "content" });
assert.equal(absent.hits, 0);
const last = await scan({ query: "rare-needle", scope: "content" });
assert.equal(last.hits, 1);
const reopenAt = performance.now();
const second = new RunStore(path);
const reopenMs = performance.now() - reopenAt;
second.close();
const deleteAt = performance.now();
const deleted = archive.deleteRuns(
  Array.from({ length: 200 }, (_, i) => `r${i + 1}`),
  "明确授权删除性能测试数据",
);
const deleteMs = performance.now() - deleteAt;
assert.equal(deleted.deleted.length, 200);
const report = {
  directory,
  synthetic: true,
  runs: 1000,
  messages: 25000,
  databaseBytes: statSync(path).size,
  writeMs,
  reopenMs,
  absent,
  last,
  delete200RunsMs: deleteMs,
  integrity: store.db.prepare("PRAGMA integrity_check").get()?.integrity_check,
  foreignKeyErrors: store.db.prepare("PRAGMA foreign_key_check").all(),
  maxRssKiB: process.resourceUsage().maxRSS,
};
recorder.close("benchmark_complete");
const raw = JSON.stringify(report, null, 2);
writeFileSync(join(directory, "benchmark.raw.json"), raw, { mode: 0o600 });
writeFileSync(
  join(directory, "benchmark.sha256"),
  `${createHash("sha256").update(raw).digest("hex")}  benchmark.raw.json\n`,
);
console.log(raw);
