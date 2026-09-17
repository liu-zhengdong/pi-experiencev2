import { randomUUID } from "node:crypto";
import type {
  ExtensionEvent,
  InputSource,
  MessageStartEvent,
} from "@earendil-works/pi-coding-agent";
import { object } from "./content.ts";
import type { Binding, CapturedEvent } from "./data.ts";
import type { RunStore } from "./store.ts";

export type RecordedEvent = Extract<
  ExtensionEvent,
  {
    type:
      | "session_start"
      | "session_info_changed"
      | "session_shutdown"
      | "session_before_fork"
      | "session_tree"
      | "agent_start"
      | "agent_end"
      | "agent_settled"
      | "turn_start"
      | "turn_end"
      | "message_start"
      | "message_update"
      | "message_end"
      | "tool_execution_start"
      | "tool_execution_update"
      | "tool_execution_end"
      | "session_compact"
      | "session_compact_failed"
      | "input"
      | "user_bash"
      | "model_select"
      | "thinking_level_select";
  }
>;

function messageKey(message: MessageStartEvent["message"]): string {
  return JSON.stringify([
    message.role,
    "toolCallId" in message ? message.toolCallId : null,
  ]);
}

/** What a recorded event stores: the event itself, or its lifecycle summary. */
type StoredPayload =
  | RecordedEvent
  | { type: "agent_end"; messageCount: number }
  | { type: "turn_end"; turnIndex: number; toolResultCount: number }
  | { type: "input"; source: InputSource }
  | {
      type: "tool_execution_start" | "tool_execution_end";
      toolCallId: string;
      toolName: string;
      isError?: boolean;
      terminate?: boolean;
    };

/** Terminal lifecycle events repeat message content already stored as message_end
 * rows. Keep the marker and counts; the bodies stay in messages. */
function lifecyclePayload(event: RecordedEvent): StoredPayload {
  if (event.type === "agent_end")
    return { type: "agent_end", messageCount: event.messages.length };
  if (event.type === "turn_end")
    return {
      type: "turn_end",
      turnIndex: event.turnIndex,
      toolResultCount: event.toolResults.length,
    };
  // The user message carries the text and images; the event keeps delivery metadata.
  if (event.type === "input") return { type: "input", source: event.source };
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end"
  )
    return {
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.type === "tool_execution_end"
        ? {
            isError: event.isError,
            terminate: object(event.result).terminate === true,
          }
        : {}),
    };
  return event;
}

/** Split the live event stream; never read native entries or JSONL. */
export class RunRecorder {
  readonly store: RunStore;
  readonly agentId: string;
  binding: Binding;
  runId: string | null = null;
  private openMessages = new Map<string, string>();
  private closed = false;

  constructor(
    store: RunStore,
    agentId: string,
    source: {
      piSessionId: string;
      cwd: string;
      title: string | null;
      reason: string;
    },
  ) {
    this.store = store;
    this.agentId = agentId;
    this.binding = store.attach({ ...source, agentId });
  }

  capture(event: RecordedEvent): void {
    const at = new Date().toISOString();
    if (event.type === "agent_start") {
      // Pi emits another agent_start for automatic continuations. Keep the same Run.
      this.runId = this.store.startRun(this.binding, this.agentId, at);
    }
    // Streamed frames carry no terminal evidence: the message_end projection and
    // the final tool result already contain the content. Writing them per frame
    // grew the log quadratically on long responses, so they stay in memory only.
    if (
      event.type === "message_update" ||
      event.type === "tool_execution_update"
    )
      return;
    const captured: CapturedEvent = {
      id: randomUUID(),
      kind: event.type,
      at,
      payload:
        event.type === "session_compact"
          ? { type: event.type, reason: event.reason }
          : lifecyclePayload(event),
    };
    if (event.type === "message_start" || event.type === "message_end") {
      const key = messageKey(event.message);
      let id = this.openMessages.get(key);
      if (!id) {
        id = randomUUID();
        this.openMessages.set(key, id);
      } else if (event.type === "message_start") {
        throw new Error("Overlapping messages have the same source identity");
      }
      // A started message has no content to preserve on its own; it lands once
      // the terminal message arrives. A crash loses only the in-flight message.
      if (event.type === "message_start") return;
      captured.message = {
        id,
        role: event.message.role,
        payload: event.message,
      };
      captured.payload = { type: "message_end" };
      this.store.append(this.binding, this.runId, captured);
      this.openMessages.delete(key);
      return;
    }
    if (event.type === "session_tree") {
      this.binding = this.store.navigate(
        this.binding,
        captured,
        event.newLeafId,
      );
      this.runId = null;
      this.openMessages.clear();
      return;
    }
    if (event.type === "agent_settled" && this.runId) {
      // Settlement closes recording, irrespective of how the model/tools ended.
      this.store.append(this.binding, this.runId, captured, true);
      this.runId = null;
      this.openMessages.clear();
      return;
    }
    this.store.append(this.binding, this.runId, captured);
    if (event.type === "session_info_changed")
      this.store.rename(this.binding, event.name ?? null);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.store.detach(this.binding, reason);
    } finally {
      this.store.close();
    }
  }
}
