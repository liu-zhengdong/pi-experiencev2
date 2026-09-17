import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { Archive } from "../src/archive.ts";
import { RunRecorder } from "../src/recorder.ts";
import { RunStore } from "../src/store.ts";
import { finishRun, workspace } from "./helpers.ts";

for (const resumeId of ["crash-session", "different-session"])
  test(`SIGKILL recovery from ${resumeId} preserves committed evidence and releases recording without inventing an end time`, {
    timeout: 15000,
  }, async (t) => {
    const f = workspace(t);
    const worker = fork(
      new URL("./crash-worker.ts", import.meta.url),
      [f.path, f.directory],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    f.cleanup(() => {
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill("SIGKILL");
    });
    const ready = await Promise.race([
      once(worker, "message"),
      once(worker, "exit").then(() => {
        throw new Error("worker exited early");
      }),
    ]);
    assert.equal(ready[0], "committed");
    const exited = once(worker, "exit");
    worker.kill("SIGKILL");
    await exited;
    const store = new RunStore(f.path);
    const recorder = new RunRecorder(store, "pi", {
      piSessionId: resumeId,
      cwd: f.directory,
      title: null,
      reason: "resume",
    });
    f.cleanup(() => recorder.close("test_cleanup"));
    const archive = new Archive(store),
      run = archive.getRun("r1");
    assert.equal(run.recording, false);
    assert.equal(run.endedAt, null);
    assert.ok(
      store
        .events(run.sessionId, run.id)
        .some(
          (event) =>
            event.kind === "archive.recording_stopped" &&
            JSON.stringify(event.payload).includes("writer_disappeared"),
        ),
    );
    const page = await archive.find({ id: "r1" });
    assert.match(page.text, /durable input/);
    assert.doesNotMatch(
      page.text,
      /unfinished output|recovery_required|结束待确认|未确认结束/,
    );
    assert.equal((await archive.find()).choices[0]?.id, "r1");
    const next = finishRun(recorder);
    assert.equal(archive.getRun(next).ordinal, 2);
    assert.equal(
      store.db.prepare("PRAGMA integrity_check").get()?.integrity_check,
      "ok",
    );
    assert.ok(
      readdirSync(f.directory).every((name) => !name.endsWith(".jsonl")),
    );
  });
