import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type Api,
  type AssistantMessage,
  type Context,
  InMemoryCredentialStore,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions,
  type Provider,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Archive } from "../src/archive.ts";
import { RunStore } from "../src/store.ts";
import { assistant, workspace } from "./helpers.ts";

export async function sdkFixture(
  t: TestContext,
  script: (
    request: number,
    context: Context,
    options: ModelsSimpleStreamOptions | undefined,
  ) => AssistantMessage | Promise<AssistantMessage>,
  summary?: (
    context: Context,
    options: ModelsApiStreamOptions<Api> | undefined,
  ) => AssistantMessage | Promise<AssistantMessage>,
  customTools: ToolDefinition[] = [],
) {
  const f = workspace(t),
    agentDir = join(f.directory, "agent");
  mkdirSync(agentDir);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("synthetic", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "never-sent",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 2048,
      },
    ],
  });
  let requestCount = 0;
  const parentRequests: Context[] = [],
    summaryRequests: Context[] = [],
    errors: string[] = [],
    scriptErrors: unknown[] = [];
  runtime.complete = async (_model, context, options) => {
    summaryRequests.push(structuredClone(context));
    try {
      if (!summary) throw new Error("Unexpected summary request");
      return await summary(context, options);
    } catch (error) {
      scriptErrors.push(error);
      throw error;
    }
  };
  const streamSimple: Provider["streamSimple"] = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      let result: AssistantMessage;
      if (options?.signal?.aborted) result = assistant("aborted");
      else {
        // SDK transport contexts may still carry tool executors. Capture the wire-serializable evidence.
        parentRequests.push(JSON.parse(JSON.stringify(context)) as Context);
        try {
          result = await script(++requestCount, context, options);
        } catch (error) {
          scriptErrors.push(error);
          result = { ...assistant("error"), errorMessage: String(error) };
        }
      }
      if (result.stopReason === "error" || result.stopReason === "aborted")
        stream.push({
          type: "error",
          reason: result.stopReason,
          error: result,
        });
      else {
        stream.push({ type: "start", partial: { ...result, content: [] } });
        const first = result.content[0];
        if (first?.type === "text")
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: first.text,
            partial: result,
          });
        stream.push({
          type: "done",
          reason: result.stopReason as "stop" | "length" | "toolUse",
          message: result,
        });
      }
      stream.end(result);
    })();
    return stream;
  };
  const provider = runtime.getProvider("synthetic");
  assert.ok(provider);
  runtime.registerNativeProvider({ ...provider, streamSimple });
  runtime.streamSimple = streamSimple;
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    enableInstallTelemetry: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: f.directory,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.flagValues.set("runs-db", f.path);
  loaded.runtime.flagValues.set("runs-no-summary", !summary);
  const model = runtime.getModel("synthetic", "fixture");
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd: f.directory,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(f.directory),
    settingsManager: settings,
    resourceLoader: loader,
    tools: [
      "read",
      "find_run",
      "get_message_detail",
      "delete_run",
      ...customTools.map((t) => t.name),
    ],
    customTools,
  });
  await session.bindExtensions({
    mode: "rpc",
    onError: (error) => errors.push(error.error),
  });
  const reader = new RunStore(f.path),
    archive = new Archive(reader);
  const sessionId = String(
    reader.db.prepare("SELECT id FROM sessions").get()?.id,
  );
  f.cleanup(() => reader.close());
  f.cleanup(() => session.dispose());
  const shutdown = async () => {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
  };
  f.cleanup(shutdown);
  const checkErrors = () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(scriptErrors, []);
  };
  return {
    ...f,
    session,
    reader,
    archive,
    sessionId,
    loaded,
    parentRequests,
    summaryRequests,
    errors,
    scriptErrors,
    checkErrors,
    shutdown,
  };
}

export async function waitFor(check: () => boolean): Promise<void> {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
