import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { textBodies } from "./content.ts";
import {
  type Binding,
  type CapturedEvent,
  integer,
  json,
  nullableText,
  parse,
  runFromRow,
  text,
} from "./data.ts";
import { initialize, validateDatabase } from "./schema.ts";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denied is not evidence of death. PID reuse conservatively blocks takeover.
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

export class RunStore {
  readonly db: DatabaseSync;
  readonly path: string;
  private closed = false;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
    }
    this.db = new DatabaseSync(path);
    try {
      validateDatabase(this.db);
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      initialize(this.db);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  attach(source: {
    piSessionId: string;
    cwd: string;
    title: string | null;
    agentId: string;
    reason: string;
  }): Binding {
    return this.transaction(() => {
      const at = new Date().toISOString();
      // Only live leases are inspected, never an archive-wide Run/message scan.
      // A crashed session must be readable even if the user starts a different session.
      for (const writer of this.db
        .prepare("SELECT * FROM writers WHERE host=?")
        .all(hostname())) {
        if (processAlive(integer(writer, "pid"))) continue;
        const sessionId = text(writer, "session_id");
        this.recoverRunning(
          { sessionId, branchId: "", token: text(writer, "token") },
          "writer_disappeared",
          at,
        );
        this.db
          .prepare("DELETE FROM writers WHERE session_id=?")
          .run(sessionId);
      }
      const existing = this.db
        .prepare("SELECT id FROM sessions WHERE pi_session_id = ? AND cwd = ?")
        .get(source.piSessionId, source.cwd);
      const sessionId = existing ? text(existing, "id") : randomUUID();
      if (!existing) {
        this.db
          .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(
            sessionId,
            source.piSessionId,
            source.cwd,
            source.title,
            source.agentId,
            at,
            at,
          );
      }
      const writer = this.db
        .prepare("SELECT * FROM writers WHERE session_id = ?")
        .get(sessionId);
      if (
        writer &&
        (text(writer, "host") !== hostname() ||
          processAlive(integer(writer, "pid")))
      ) {
        throw new Error(
          `Session already has a live writer (${text(writer, "host")}:${integer(writer, "pid")})`,
        );
      }
      this.db
        .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
        .run(source.title, at, sessionId);
      const branch = this.db
        .prepare(
          "SELECT id FROM branches WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(sessionId);
      const branchId = branch ? text(branch, "id") : randomUUID();
      if (!branch) {
        this.db
          .prepare("INSERT INTO branches VALUES (?, ?, NULL, NULL, ?, ?)")
          .run(
            branchId,
            sessionId,
            source.reason === "fork" ? "fork_origin_unknown" : "root",
            at,
          );
      }
      const binding = { sessionId, branchId, token: randomUUID() };
      this.db
        .prepare("INSERT OR REPLACE INTO writers VALUES (?, ?, ?, ?)")
        .run(sessionId, binding.token, hostname(), process.pid);
      this.recoverRunning(binding, "writer_disappeared", at);
      return binding;
    });
  }

  private assertWriter(binding: Binding): void {
    const writer = this.db
      .prepare("SELECT token FROM writers WHERE session_id = ?")
      .get(binding.sessionId);
    if (!writer || text(writer, "token") !== binding.token)
      throw new Error("Run archive writer ownership lost");
  }

  startRun(binding: Binding, agentId: string, at: string): string {
    return this.transaction(() => {
      this.assertWriter(binding);
      const existing = this.db
        .prepare(
          "SELECT id FROM runs WHERE session_id = ? AND status = 'running'",
        )
        .get(binding.sessionId);
      if (existing) return text(existing, "id");
      const next = this.db
        .prepare(
          "SELECT COALESCE(MAX(number), 0) + 1 AS number FROM runs WHERE session_id = ?",
        )
        .get(binding.sessionId);
      if (!next) throw new Error("Cannot allocate Run number");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO runs (id, session_id, branch_id, number, agent_id, status, started_at, ended_at, updated_at, reason) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?, NULL)",
        )
        .run(
          id,
          binding.sessionId,
          binding.branchId,
          integer(next, "number"),
          agentId,
          at,
          at,
        );
      return id;
    });
  }

  append(
    binding: Binding,
    runId: string | null,
    event: CapturedEvent,
    finish = false,
  ): void {
    this.transaction(() => {
      this.assertWriter(binding);
      const inserted = this.insertEvent(binding, runId, event);
      if (!inserted) return;
      if (finish && runId) this.finishRun(runId, event.at, event.at);
    });
  }

  private insertEvent(
    binding: Binding,
    runId: string | null,
    event: CapturedEvent,
  ): boolean {
    // A message body is stored exactly once, in messages. The event is its marker.
    const payload = json(event.message ? { type: event.kind } : event.payload);
    const fingerprint = createHash("sha256")
      .update(json([binding.sessionId, binding.branchId, runId, event]))
      .digest("hex");
    const previous = this.db
      .prepare("SELECT * FROM events WHERE id = ?")
      .get(event.id);
    if (previous) {
      if (text(previous, "fingerprint") !== fingerprint) {
        throw new Error("Event ID reused with different content");
      }
      return false;
    }
    if (runId) {
      const run = this.db
        .prepare("SELECT status FROM runs WHERE id = ? AND session_id = ?")
        .get(runId, binding.sessionId);
      if (!run || text(run, "status") !== "running")
        throw new Error("Cannot append to a closed or foreign Run");
    }
    const result = this.db
      .prepare(
        "INSERT INTO events (id, session_id, run_id, branch_id, kind, captured_at, message_id, payload, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        binding.sessionId,
        runId,
        binding.branchId,
        event.kind,
        event.at,
        event.message?.id ?? null,
        payload,
        fingerprint,
      );
    if (event.message) {
      const message = event.message;
      if (this.db.prepare("SELECT 1 FROM messages WHERE id=?").get(message.id))
        throw new Error("Cannot change a terminal or foreign message");
      this.db
        .prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          message.id,
          binding.sessionId,
          runId,
          binding.branchId,
          message.role,
          result.lastInsertRowid,
          json(message.payload),
        );
      if (runId && message.role === "user") {
        const goal = textBodies(message.payload).join("\n").slice(0, 512);
        this.db
          .prepare("UPDATE runs SET goal = ? WHERE id = ? AND goal = ''")
          .run(goal, runId);
      }
    }
    this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(event.at, binding.sessionId);
    return true;
  }

  private finishRun(runId: string, endedAt: string | null, at: string): void {
    // Keep the existing on-disk encoding: 'completed' only means recording stopped.
    // No migration or history rewrite is needed.
    this.db
      .prepare(
        "UPDATE runs SET status = 'completed', ended_at = ?, updated_at = ?, reason = NULL WHERE id = ? AND status = 'running'",
      )
      .run(endedAt, at, runId);
  }

  private recoverRunning(binding: Binding, reason: string, at: string): void {
    const active = this.db
      .prepare(
        "SELECT id, branch_id FROM runs WHERE session_id = ? AND status = 'running'",
      )
      .get(binding.sessionId);
    if (active) {
      const id = text(active, "id");
      this.insertEvent(
        { ...binding, branchId: text(active, "branch_id") },
        id,
        {
          id: randomUUID(),
          kind: "archive.recording_stopped",
          at,
          payload: { reason },
        },
      );
      // We observed recording stop, not the original execution's end time.
      this.finishRun(id, null, at);
    }
  }

  navigate(
    binding: Binding,
    event: CapturedEvent,
    targetHint: string | null,
  ): Binding {
    return this.transaction(() => {
      this.assertWriter(binding);
      this.recoverRunning(
        binding,
        "branch_changed_before_settlement",
        event.at,
      );
      const next = { ...binding, branchId: randomUUID() };
      this.db
        .prepare(
          "INSERT INTO branches VALUES (?, ?, ?, ?, 'tree_navigation', ?)",
        )
        .run(
          next.branchId,
          binding.sessionId,
          binding.branchId,
          targetHint,
          event.at,
        );
      this.insertEvent(next, null, event);
      return next;
    });
  }

  rename(binding: Binding, name: string | null): void {
    this.transaction(() => {
      this.assertWriter(binding);
      this.db
        .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
        .run(name, new Date().toISOString(), binding.sessionId);
    });
  }

  detach(binding: Binding, reason: string): void {
    this.transaction(() => {
      this.assertWriter(binding);
      this.recoverRunning(binding, reason, new Date().toISOString());
      this.db
        .prepare("DELETE FROM writers WHERE session_id = ? AND token = ?")
        .run(binding.sessionId, binding.token);
    });
  }

  runs(sessionId: string, afterNumber = 0, limit = 50) {
    this.checkPage(afterNumber, limit);
    return this.db
      .prepare(
        "SELECT * FROM runs WHERE session_id = ? AND number > ? ORDER BY number LIMIT ?",
      )
      .all(sessionId, afterNumber, limit)
      .map(runFromRow);
  }

  run(sessionId: string, number: number) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("Run number must be a positive safe integer");
    const row = this.db
      .prepare("SELECT * FROM runs WHERE session_id = ? AND number = ?")
      .get(sessionId, number);
    return row ? runFromRow(row) : null;
  }

  events(sessionId: string, runId: string | null, after = 0, limit = 50) {
    this.checkPage(after, limit);
    return this.db
      .prepare(
        "SELECT * FROM events WHERE session_id = ? AND (? IS NULL OR run_id = ?) AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(sessionId, runId, runId, after, limit)
      .map((row) => ({
        sequence: integer(row, "seq"),
        id: text(row, "id"),
        runId: nullableText(row, "run_id"),
        branchId: text(row, "branch_id"),
        kind: text(row, "kind"),
        capturedAt: text(row, "captured_at"),
        messageId: nullableText(row, "message_id"),
        payload: parse(text(row, "payload")),
      }));
  }

  messages(sessionId: string, runId: string | null, after = 0, limit = 50) {
    this.checkPage(after, limit);
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? AND (? IS NULL OR run_id = ?) AND first_seq > ? ORDER BY first_seq LIMIT ?",
      )
      .all(sessionId, runId, runId, after, limit)
      .map((row) => ({
        id: text(row, "id"),
        runId: nullableText(row, "run_id"),
        branchId: text(row, "branch_id"),
        role: text(row, "role"),
        sequence: integer(row, "first_seq"),
        payload: parse(text(row, "payload")),
      }));
  }

  private checkPage(after: number, limit: number): void {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new Error(
        "Expected a nonnegative cursor and a page size between 1 and 200",
      );
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
