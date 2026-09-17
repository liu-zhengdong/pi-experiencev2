import assert from "node:assert/strict";
import { test } from "node:test";
import { messagePreview, textBodies } from "../src/content.ts";
import { assistant, finishRun, recording, toolCall } from "./helpers.ts";
import { sdkFixture } from "./sdk-helper.ts";

const failure = () => ({
  ...assistant("error", ""),
  content: [],
  errorMessage: "fetch failed",
});

test("empty model failures appear in previews and content search without rewriting raw messages", async (t) => {
  const f = recording(t),
    message = failure();
  finishRun(f.recorder, "Inspect the provider response", message);
  const page = await f.archive.find({ id: "r1" });
  assert.match(page.text, /assistant\n错误：fetch failed/);
  assert.match(page.displayText, /错误：fetch failed/);
  const ref = page.choices.at(-1)?.id;
  assert.ok(ref);
  const hit = await f.archive.find({ query: "fetch failed", scope: "content" });
  assert.deepEqual(
    hit.choices.map((c) => c.id),
    ["r1"],
  );
  assert.ok(hit.text.includes(`命中 ${ref} · fetch failed`));
  assert.deepEqual(
    JSON.parse(f.archive.detail({ id: ref, format: "raw" }).displayText),
    message,
  );
  assert.match(
    messagePreview({
      ...failure(),
      content: [{ type: "text", text: "已留下部分结果" }],
    }),
    /^错误：fetch failed\n已留下部分结果/,
  );
  assert.equal(
    messagePreview({ ...assistant(), content: [] }),
    "[无正文，按 ID 展开]",
  );
  const oversized = messagePreview({
    ...failure(),
    errorMessage: "🧪".repeat(10_000),
  });
  assert.ok(oversized.length < 850);
  assert.ok(!/[\uD800-\uDBFF]$/u.test(oversized));
  const longId = finishRun(f.recorder, "long response", {
    ...failure(),
    content: Array.from({ length: 5 }, () => ({
      type: "text" as const,
      text: "长正文".repeat(500),
    })),
  });
  assert.match(
    (await f.archive.find({ id: longId })).text,
    /assistant\n错误：fetch failed/,
  );
});

test("adding readable errors does not index reasoning, transport diagnostics or other metadata, or merge text blocks", async (t) => {
  const f = recording(t);
  finishRun(f.recorder, "seed", {
    ...failure(),
    content: [
      { type: "text", text: "visible-body" },
      { type: "thinking", thinking: "secret-thought" },
      {
        type: "toolCall",
        name: "read",
        id: "c",
        arguments: { path: "private-argument" },
      },
    ],
    model: "metadata-model",
  });
  for (const query of [
    "secret-thought",
    "private-argument",
    "metadata-model",
    "visible-body fetch",
    "error",
  ])
    assert.equal(
      (await f.archive.find({ query, scope: "content" })).choices.length,
      0,
      query,
    );
  const diagnostic = {
    ...failure(),
    diagnostics: [{ message: "transport-stack" }],
  };
  assert.deepEqual(textBodies(diagnostic), ["fetch failed"]);
  assert.doesNotMatch(messagePreview(diagnostic), /transport-stack/);
  assert.deepEqual(
    textBodies({
      role: "user",
      content: "user text",
      errorMessage: "not-model-error",
    }),
    ["user text"],
  );
  assert.deepEqual(
    textBodies({ ...failure(), errorMessage: { private: "not-a-string" } }),
    [],
  );
});

test("fresh real SDK tool calls find and read an empty model failure", async (t) => {
  let phase: "record" | "find" | "detail" = "record",
    detailId = "";
  const f = await sdkFixture(t, (_request, context) => {
    if (phase === "record") return failure();
    if (context.messages.at(-1)?.role === "toolResult") return assistant();
    return phase === "find"
      ? toolCall("find_run", { query: "fetch failed", scope: "content" })
      : toolCall("get_message_detail", { id: detailId });
  });
  await f.session.prompt("Record the provider failure");
  phase = "find";
  await f.session.prompt("Find the archived provider error");
  const found = f.session.messages.find(
    (m) => m.role === "toolResult" && m.toolName === "find_run",
  );
  assert.ok(found && found.role === "toolResult");
  assert.equal(found.isError, false);
  const output = JSON.stringify(found.content);
  detailId = /命中 (m\d+)/.exec(output)?.[1] ?? "";
  assert.ok(detailId, output);
  assert.match(output, /fetch failed/);
  phase = "detail";
  await f.session.prompt("Read that error in full");
  const detail = f.session.messages.find(
    (m) => m.role === "toolResult" && m.toolName === "get_message_detail",
  );
  assert.ok(detail && detail.role === "toolResult");
  assert.equal(detail.isError, false);
  assert.match(JSON.stringify(detail.content), /fetch failed/);
  f.checkErrors();
});
