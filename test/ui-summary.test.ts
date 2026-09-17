import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  providerSessionHeaders,
  summaryContext,
  validateSummary,
} from "../src/summary.ts";
import { RunPanel } from "../src/ui.ts";
import { assistant, finishRun, recording } from "./helpers.ts";
import { sdkFixture, waitFor } from "./sdk-helper.ts";

test("panel renders bounded rows/columns, sanitizes terminal controls and supports scroll/back/actions", () => {
  const actions: string[] = [],
    theme = { fg: (_key: string, s: string) => s, bold: (s: string) => s };
  for (const width of [1, 12, 32, 80, 120])
    for (const height of [3, 8, 24]) {
      const panel = new RunPanel(
        "Run 归档",
        `\x1b]52;c;dGVzdA==\x07${"消息与工具结果 🧪\n".repeat(300)}`,
        "O 打开",
        () => height,
        (a) => actions.push(a),
        () => {},
        theme,
      );
      const first = panel.render(width);
      assert.ok(first.length <= height);
      assert.ok(first.every((s) => visibleWidth(s) <= width));
      assert.equal(first.join("\n").includes("\x1b]52"), false);
      panel.handleInput("\x1b[6~");
      panel.render(width);
      panel.handleInput("\x1b[F");
      panel.render(width);
      panel.handleInput("o");
      panel.handleInput("\x1b");
    }
  assert.ok(actions.includes("o"));
  assert.ok(actions.includes("back"));
});

test("summary validator rejects incomplete, blank, oversized and tool-call responses", () => {
  for (const result of [
    assistant("length"),
    assistant("stop", " "),
    assistant("stop", "中".repeat(201)),
    {
      ...assistant(),
      content: [
        {
          type: "toolCall",
          id: "malicious",
          name: "delete_run",
          arguments: {},
        },
      ],
    },
  ])
    assert.throws(() => validateSummary(result));
  assert.equal(
    validateSummary(assistant("stop", "🧪".repeat(200))),
    "🧪".repeat(200),
  );
});

test("provider error messages surface instead of the generic validator text", () => {
  assert.throws(
    () =>
      validateSummary({
        ...assistant("error"),
        errorMessage:
          '400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}',
      }),
    /x-opencode-session/,
  );
});

test("opencode endpoints get session routing headers, others stay untouched", () => {
  const model = (provider: string, baseUrl: string) =>
    ({
      provider,
      baseUrl,
    }) as never;
  for (const m of [
    model("opencode-go", "https://opencode.ai/zen/go/v1"),
    model("opencode", "https://opencode.ai/zen/v1"),
    model("synthetic", "https://opencode.ai/zen/go/v1"),
  ])
    assert.deepEqual(providerSessionHeaders(m, "s1"), {
      "x-opencode-session": "s1",
      "x-opencode-client": "pi",
    });
  for (const m of [
    model("openai", "https://api.openai.com/v1"),
    model("synthetic", "http://127.0.0.1:1"),
  ])
    assert.equal(providerSessionHeaders(m, "s1"), undefined);
});

// providerSessionHeaders mirrors pi's private getSessionHeaders (provider-attribution.js).
// Compare against the live upstream implementation so a silent rule change upstream
// breaks this test instead of summarization again.
test("providerSessionHeaders matches pi's getSessionHeaders across model shapes", async () => {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { mergeProviderAttributionHeaders } = await import(
    new URL("./core/provider-attribution.js", entry).href
  );
  // Telemetry off => upstream merge reduces to getSessionHeaders exactly.
  const settings = { getEnableInstallTelemetry: () => false };
  const shapes = [
    { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" },
    { provider: "opencode", baseUrl: "https://opencode.ai/zen/v1" },
    { provider: "synthetic", baseUrl: "https://opencode.ai/zen/go/v1" },
    { provider: "opencode-go", baseUrl: "https://notopencode.ai/v1" },
    { provider: "openai", baseUrl: "https://api.openai.com/v1" },
    { provider: "synthetic", baseUrl: "http://127.0.0.1:1" },
    { provider: "synthetic", baseUrl: "not a url" },
  ];
  for (const shape of shapes)
    for (const sessionId of ["s1", ""]) {
      assert.deepEqual(
        providerSessionHeaders(shape as never, sessionId),
        mergeProviderAttributionHeaders(
          shape as never,
          settings as never,
          sessionId,
        ),
        `${shape.provider} ${shape.baseUrl} sid=${JSON.stringify(sessionId)}`,
      );
    }
});

test("summary evidence keeps final answer and explicit error, strips reasoning, and remains bounded", (t) => {
  const f = recording(t);
  const id = finishRun(f.recorder, "真实验证目标", {
    ...assistant("error", ""),
    errorMessage: "transport failure",
    content: [
      { type: "thinking", thinking: "NOT_EVIDENCE".repeat(10000) },
      { type: "text", text: "已写文件，测试未通过。" },
    ],
  });
  const context = summaryContext(f.archive, id);
  assert.match(JSON.stringify(context), /已写文件，测试未通过/);
  assert.match(JSON.stringify(context), /transport failure/);
  assert.doesNotMatch(
    JSON.stringify(context),
    /NOT_EVIDENCE|Run状态|recovery_required|completed/,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 52_000);
});

test("failed background summary preserves raw evidence and does not resume recording", async (t) => {
  const f = await sdkFixture(
    t,
    () => assistant(),
    () => assistant("stop", "超".repeat(201)),
  );
  await f.session.prompt("Raw evidence must survive");
  await waitFor(() => !!f.archive.getRun("r1").summaryError);
  const run = f.archive.getRun("r1");
  assert.equal(run.recording, false);
  assert.equal(run.overview, null);
  assert.equal(f.summaryRequests.length, 2);
  assert.match((await f.archive.find({ id: "r1" })).text, /Raw evidence/);
  f.checkErrors();
});

test("Pi schema validation rejects malformed delete arguments before side effects", async (t) => {
  const f = await sdkFixture(t, (n) =>
    n === 2
      ? {
          ...assistant("toolUse"),
          content: [
            {
              type: "toolCall",
              id: "bad",
              name: "delete_run",
              arguments: { ids: { invalid: "r1" }, reason: "invalid type" },
            },
          ],
        }
      : assistant(),
  );
  await f.session.prompt("Record first");
  await f.session.prompt("Exercise malformed tool call");
  assert.equal(f.archive.getRun("r1").recording, false);
  const result = f.session.messages.find((m) => m.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.doesNotMatch(
    stripTerminalSequences(JSON.stringify(f.session.messages)),
    /deleted_runs/,
  );
  f.checkErrors();
});
