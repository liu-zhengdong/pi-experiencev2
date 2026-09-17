import { RunRecorder } from "../src/recorder.ts";
import { RunStore } from "../src/store.ts";
import { assistant } from "./helpers.ts";

const [path, cwd] = process.argv.slice(2);
if (!path || !cwd) throw new Error("path and cwd required");
const recorder = new RunRecorder(new RunStore(path), "pi", {
  piSessionId: "crash-session",
  cwd,
  title: null,
  reason: "startup",
});
recorder.capture({ type: "agent_start" });
recorder.capture({
  type: "message_end",
  message: { role: "user", content: "durable input", timestamp: 1 },
});
recorder.capture({
  type: "message_start",
  message: assistant("stop", "unfinished output"),
});
process.send?.("committed");
setInterval(() => {}, 1000);
