// Explicit, bounded live check. Raw evidence stays outside the repository/formatter.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Archive } from "../src/archive.ts";
import { RunStore } from "../src/store.ts";

const directory = process.env.EVIDENCE_DIR
  ? resolve(process.env.EVIDENCE_DIR)
  : mkdtempSync(join(tmpdir(), "pi-runs-live-"));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const provider = process.env.PI_PROVIDER,
  modelId = process.env.PI_MODEL;
if (!provider || !modelId)
  throw new Error(
    "Set PI_PROVIDER and PI_MODEL to an existing configured model",
  );
const runtime = await ModelRuntime.create({
  allowModelNetwork: false,
  refreshOnCreate: false,
  signal: AbortSignal.timeout(15000),
});
const model = runtime.getModel(provider, modelId);
if (!model) throw new Error("Configured model not found");
const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const sourceHashes = () =>
  Object.fromEntries(
    readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(sourceDirectory, name)))
          .digest("hex"),
      ]),
  );
const sourceBefore = sourceHashes();
const evidence: Record<string, unknown>[] = [];
const nativeComplete = runtime.complete.bind(runtime);
let summaryCalls = 0,
  parentCalls = 0;
runtime.complete = async (m, context, options) => {
  if (++summaryCalls > 2) throw new Error("Summary request cap exceeded");
  const start = Date.now();
  assert.doesNotMatch(
    JSON.stringify(context),
    /Run状态|recovery_required|completed只表示/,
  );
  const response = await nativeComplete(m, context, options);
  evidence.push({
    kind: "summary",
    provider: m.provider,
    model: m.id,
    elapsedMs: Date.now() - start,
    context,
    response,
  });
  return response;
};
const cwd = resolve(fileURLToPath(new URL("..", import.meta.url))),
  agentDir = join(directory, "agent");
mkdirSync(agentDir, { recursive: true });
const settings = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
  enableInstallTelemetry: false,
});
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: settings,
  noExtensions: true,
  noContextFiles: true,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  systemPromptOverride: () =>
    "你是用于验证归档插件的助手。按用户要求简短回复，不执行工具。",
  additionalExtensionPaths: [
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  ],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const database = join(directory, "live.sqlite");
if (existsSync(database))
  throw new Error(
    "Use a fresh evidence directory; existing evidence is never overwritten",
  );
loader.getExtensions().runtime.flagValues.set("runs-db", database);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  tools: ["find_run", "get_message_detail", "delete_run"],
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: settings,
  resourceLoader: loader,
});
const nativeStream = session.agent.streamFunction;
session.agent.streamFunction = (m, context, options) => {
  if (++parentCalls > 1) throw new Error("Parent request cap exceeded");
  evidence.push({
    kind: "parent-request",
    provider: m.provider,
    model: m.id,
    context: JSON.parse(JSON.stringify(context)),
  });
  assert.deepEqual(context.tools?.map((tool) => tool.name).sort(), [
    "delete_run",
    "find_run",
    "get_message_detail",
  ]);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0]?.role, "user");
  assert.equal(
    context.systemPrompt,
    `你是用于验证归档插件的助手。按用户要求简短回复，不执行工具。\nCurrent working directory: ${cwd}\n`,
  );
  return nativeStream(m, context, {
    ...options,
    signal: AbortSignal.any([
      ...(options?.signal ? [options.signal] : []),
      AbortSignal.timeout(45000),
    ]),
    timeoutMs: 45000,
    maxRetries: 0,
    maxTokens: 512,
  });
};
const errors: string[] = [];
await session.bindExtensions({
  mode: "print",
  onError: (error) => errors.push(error.error),
});
console.log(
  JSON.stringify({
    provider,
    model: modelId,
    authSource: "existing Pi auth/models configuration",
    parentCap: 1,
    summaryCap: 2,
    summaryTimeoutMs: 120000,
  }),
);
let store: RunStore | undefined;
try {
  await session.prompt(
    "这是Run归档验证。请只回复：已收到验证请求；未修改文件。",
    { expandPromptTemplates: false },
  );
  store = new RunStore(database);
  const archive = new Archive(store);
  // Exercise the real print-mode shutdown drain rather than artificially awaiting the summary.
  const started = Date.now();
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  const run = archive.getRun("r1");
  const page = await archive.find({ id: "r1" });
  evidence.push({
    kind: "observed-archive",
    shutdownDrainMs: Date.now() - started,
    run,
    page,
    messages: session.messages,
    errors,
  });
  assert.equal(run.recording, false);
  assert.equal("status" in run, false);
  assert.equal(page.text.split("\n")[0], "r1");
  assert.doesNotMatch(
    page.displayText.split("\n")[0] ?? "",
    /已收束|进行中|失败|已中止|结束待确认/,
  );
  assert.ok(run.overview);
  assert.ok(Array.from(run.overview).length <= 200);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      database,
      overview: run.overview,
      parentCalls,
      summaryCalls,
    }),
  );
} finally {
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  session.dispose();
  store?.close();
  const sourceAfter = sourceHashes();
  const raw = JSON.stringify(
    {
      at: new Date().toISOString(),
      provider,
      model: modelId,
      sourceBefore,
      sourceAfter,
      evidence,
    },
    null,
    2,
  );
  const path = join(directory, "live-entry.raw.json"),
    sha256 = createHash("sha256").update(raw).digest("hex");
  writeFileSync(path, raw, { mode: 0o600, flag: "wx" });
  writeFileSync(
    join(directory, "live-entry.sha256"),
    `${sha256}  live-entry.raw.json\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify({ path, sha256 }));
  assert.deepEqual(
    sourceAfter,
    sourceBefore,
    "Source changed during live verification",
  );
}
