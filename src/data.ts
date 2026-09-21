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
    sessionRef: integer(row, "session_ref"),
    branchRef: integer(row, "branch_ref"),
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

/** Identifies the session and branch a recorder writes to. Events reference
 *  rows by their integer keys, so the binding carries those rather than the
 *  text ids, which exist only for citations that outlive a database. */
export interface Binding {
  sessionRef: number;
  branchRef: number;
  token: string;
}
