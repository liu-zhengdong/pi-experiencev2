import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Archive } from "../src/archive.ts";
import { RunRecorder } from "../src/recorder.ts";
import { RunStore } from "../src/store.ts";

export function assistant(
  stopReason: AssistantMessage["stopReason"] = "stop",
  value = "Done",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: value }],
    api: "openai-completions",
    provider: "synthetic",
    model: "fixture",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 2,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function workspace(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "pi-runs-test-"));
  const cleanups: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    try {
      for (const fn of cleanups.reverse()) await fn();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    directory,
    path: join(directory, "runs.sqlite"),
    cleanup: (fn: () => void | Promise<void>) => cleanups.push(fn),
  };
}
export function recording(t: TestContext) {
  const f = workspace(t),
    store = new RunStore(f.path);
  const recorder = new RunRecorder(store, "pi", {
    piSessionId: "test-session",
    cwd: f.directory,
    title: null,
    reason: "startup",
  });
  f.cleanup(() => recorder.close("test_cleanup"));
  return {
    ...f,
    store,
    recorder,
    archive: new Archive(store),
    sessionId: recorder.binding.sessionId,
  };
}
export function finishRun(
  recorder: RunRecorder,
  content = "Work",
  result = assistant(),
): string {
  recorder.capture({ type: "agent_start" });
  const id = recorder.runId;
  assert.ok(id);
  const user = { role: "user" as const, content, timestamp: Date.now() };
  for (const message of [user, result]) {
    recorder.capture({ type: "message_start", message });
    recorder.capture({ type: "message_end", message });
  }
  recorder.capture({ type: "agent_settled" });
  return id;
}
export function toolCall(
  name: string,
  args: Record<string, unknown>,
): AssistantMessage {
  return {
    ...assistant("toolUse"),
    content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
  };
}
