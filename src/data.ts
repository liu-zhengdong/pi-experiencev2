import type { SQLOutputValue } from "node:sqlite";

type Row = Record<string, SQLOutputValue>;

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Invalid database text: ${key}`);
  return value;
}

export function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid database integer: ${key}`);
  }
  return value;
}

export function nullableText(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

export function json(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Event has no JSON representation");
  return result;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function parse(value: string): JsonValue {
  try {
    // Without a reviver, JSON.parse can only produce JSON values.
    return JSON.parse(value) as JsonValue;
  } catch (cause) {
    throw new Error("Invalid archived JSON", { cause });
  }
}

export function runFromRow(row: Row) {
  // Existing RUN2 schema-1 values remain readable; only the recording bit is used.
  const status = text(row, "status");
  if (
    status !== "running" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "interrupted" &&
    status !== "recovery_required"
  ) {
    throw new Error(`Invalid stored recording marker: ${status}`);
  }
  return {
    id: text(row, "id"),
    ordinal: integer(row, "ordinal"),
    overview: nullableText(row, "overview"),
    summaryError: nullableText(row, "summary_error"),
    goal: text(row, "goal"),
    sessionId: text(row, "session_id"),
    branchId: text(row, "branch_id"),
    number: integer(row, "number"),
    agentId: text(row, "agent_id"),
    recording: status === "running",
    startedAt: text(row, "started_at"),
    endedAt: nullableText(row, "ended_at"),
  };
}

export interface MessageSnapshot {
  id: string;
  role: string;
  payload: unknown;
}

export interface CapturedEvent {
  id: string;
  kind: string;
  at: string;
  payload: unknown;
  message?: MessageSnapshot;
}

export interface Binding {
  sessionId: string;
  branchId: string;
  token: string;
}
