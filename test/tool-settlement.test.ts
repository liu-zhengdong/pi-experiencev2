import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { assistant, recording, toolCall } from "./helpers.ts";
import { sdkFixture, waitFor } from "./sdk-helper.ts";

for (const cancel of [false, true]) {
  test(`SDK terminating tool ${cancel ? "with cancellation" : "without cancellation"} stops recording and gets a summary`, async (t) => {
    const f = await sdkFixture(
      t,
      () => toolCall("finish", {}),
      () => assistant("stop", "本轮通过工具返回结果，执行已结束。"),
      [
        defineTool({
          name: "finish",
          label: "Finish",
          description: "Finish without a follow-up model response",
          parameters: Type.Object({}),
          async execute(_id, _args, _signal, _update, ctx) {
            if (cancel) ctx.abort();
            return {
              content: [{ type: "text" as const, text: "Report delivered." }],
              details: {},
              terminate: true,
            };
          },
        }),
      ],
    );
    await f.session.prompt("Return a report through the finishing tool");
    assert.equal(f.parentRequests.length, 1);
    assert.equal(f.archive.getRun("r1").recording, false);
    assert.ok(f.archive.getRun("r1").endedAt);
    assert.ok(
      f.reader
        .events(f.sessionId, f.archive.getRun("r1").id)
        .some(
          (event) =>
            event.kind === "tool_execution_end" &&
            JSON.stringify(event.payload).includes('"terminate":true'),
        ),
    );
    assert.match((await f.archive.find({ id: "r1" })).text, /工具结果 finish/);
    await waitFor(() => !!f.archive.getRun("r1").overview);
    f.checkErrors();
  });
}

test("settlement stops recording without classifying missing, foreign or non-terminating tool results", (t) => {
  for (const kind of ["missing", "foreign", "non-terminating"]) {
    const f = recording(t);
    f.recorder.capture({ type: "agent_start" });
    f.recorder.capture({
      type: "message_end",
      message: toolCall("finish", {}),
    });
    if (kind !== "missing") {
      const toolCallId = kind === "foreign" ? "different-call" : "call-finish";
      f.recorder.capture({
        type: "tool_execution_end",
        toolCallId,
        toolName: "finish",
        result: { content: [], terminate: kind !== "non-terminating" },
        isError: false,
      });
      f.recorder.capture({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId,
          toolName: "finish",
          content: [{ type: "text", text: "Returned" }],
          isError: false,
          timestamp: 0,
        },
      });
    }
    const id = f.recorder.runId;
    assert.ok(id);
    const messages = f.store.messages(f.sessionId, id);
    f.recorder.capture({ type: "agent_settled" });
    assert.equal(f.archive.getRun("r1").recording, false, kind);
    assert.ok(f.archive.getRun("r1").endedAt);
    assert.equal("status" in f.archive.getRun("r1"), false);
    assert.deepEqual(f.store.messages(f.sessionId, id), messages);
  }
});
