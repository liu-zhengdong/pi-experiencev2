import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BlobStore, externalize } from "./blobs.ts";
import {
  type Dictionaries,
  decodeRow,
  encode,
  openDictionaries,
  refreshDictionary,
} from "./codec.ts";
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

/** Messages written between two checks for whether a new dictionary is due. */
const DICTIONARY_CHECK_INTERVAL = 500;

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
  readonly blobs: BlobStore;
  dictionaries: Dictionaries;
  private writeDictionary: { id: number; bytes: Buffer } | undefined;
  private sinceDictionaryCheck = 0;
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
    this.blobs = new BlobStore(
      path === ":memory:" ? join(process.cwd(), ".run-blobs") : `${path}-blobs`,
    );
    this.dictionaries = openDictionaries(this.db);
    this.writeDictionary = this.dictionaries.current;
  }

  /** Reclaims the pages a Run deletion released. Incremental so a large archive
   *  is not rewritten in full on the way out of a delete. */
  reclaim(): void {
    this.db.exec("PRAGMA incremental_vacuum;");
  }

  /** Picks up a dictionary written by another path, such as a compaction pass. */
  reloadDictionaries(): void {
    this.dictionaries = openDictionaries(this.db);
    this.writeDictionary = this.dictionaries.current;
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
        const sessionRef = integer(writer, "session_ref");
        this.recoverRunning(
          { sessionRef, branchRef: 0, token: text(writer, "token") },
          "writer_disappeared",
          at,
        );
        this.db
          .prepare("DELETE FROM writers WHERE session_ref=?")
          .run(sessionRef);
      }
      const existing = this.db
        .prepare("SELECT ref FROM sessions WHERE pi_session_id = ? AND cwd = ?")
        .get(source.piSessionId, source.cwd);
      const sessionRef = existing
        ? integer(existing, "ref")
        : Number(
            this.db
              .prepare(
                "INSERT INTO sessions (id, pi_session_id, cwd, title, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ref",
              )
              .get(
                randomUUID(),
                source.piSessionId,
                source.cwd,
                source.title,
                source.agentId,
                at,
                at,
              )?.ref,
          );
      const writer = this.db
        .prepare("SELECT * FROM writers WHERE session_ref = ?")
        .get(sessionRef);
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
        .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE ref = ?")
        .run(source.title, at, sessionRef);
      const branch = this.db
        .prepare(
          "SELECT ref FROM branches WHERE session_ref = ? ORDER BY ref DESC LIMIT 1",
        )
        .get(sessionRef);
      const branchRef = branch
        ? integer(branch, "ref")
        : Number(
            this.db
              .prepare(
                "INSERT INTO branches (id, session_ref, previous_branch_ref, source_target_hint, reason, created_at) VALUES (?, ?, NULL, NULL, ?, ?) RETURNING ref",
              )
              .get(
                randomUUID(),
                sessionRef,
                source.reason === "fork" ? "fork_origin_unknown" : "root",
                at,
              )?.ref,
          );
      const binding = { sessionRef, branchRef, token: randomUUID() };
      this.db
        .prepare("INSERT OR REPLACE INTO writers VALUES (?, ?, ?, ?)")
        .run(sessionRef, binding.token, hostname(), process.pid);
      this.recoverRunning(binding, "writer_disappeared", at);
      return binding;
    });
  }

  private assertWriter(binding: Binding): void {
    const writer = this.db
      .prepare("SELECT token FROM writers WHERE session_ref = ?")
      .get(binding.sessionRef);
    if (!writer || text(writer, "token") !== binding.token)
      throw new Error("Run archive writer ownership lost");
  }

  startRun(binding: Binding, agentId: string, at: string): number {
    return this.transaction(() => {
      this.assertWriter(binding);
      const existing = this.db
        .prepare(
          "SELECT ordinal FROM runs WHERE session_ref = ? AND status = 'running'",
        )
        .get(binding.sessionRef);
      if (existing) return integer(existing, "ordinal");
      const next = this.db
        .prepare(
          "SELECT COALESCE(MAX(number), 0) + 1 AS number FROM runs WHERE session_ref = ?",
        )
        .get(binding.sessionRef);
      if (!next) throw new Error("Cannot allocate Run number");
      const inserted = this.db
        .prepare(
          "INSERT INTO runs (id, session_ref, branch_ref, number, agent_id, status, started_at, ended_at, updated_at, reason) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?, NULL) RETURNING ordinal",
        )
        .get(
          randomUUID(),
          binding.sessionRef,
          binding.branchRef,
          integer(next, "number"),
          agentId,
          at,
          at,
        );
      return Number(inserted?.ordinal);
    });
  }

  append(
    binding: Binding,
    runRef: number | null,
    event: CapturedEvent,
    finish = false,
  ): void {
    this.transaction(() => {
      this.assertWriter(binding);
      const inserted = this.insertEvent(binding, runRef, event);
      if (!inserted) return;
      if (finish && runRef) this.finishRun(runRef, event.at, event.at);
    });
  }

  private insertEvent(
    binding: Binding,
    runRef: number | null,
    event: CapturedEvent,
  ): boolean {
    // A message body is stored exactly once, in messages. The event is its marker.
    const payload = json(event.message ? { type: event.kind } : event.payload);
    // Eight bytes of digest distinguish a genuine replay from a reused id across
    // an archive of this size; it guards consistency, not a trust boundary.
    const fingerprint = createHash("sha256")
      .update(json([binding.sessionRef, binding.branchRef, runRef, event]))
      .digest()
      .subarray(0, 8);
    const previous = this.db
      .prepare("SELECT fingerprint FROM events WHERE id = ?")
      .get(event.id);
    if (previous) {
      const stored = previous.fingerprint;
      if (
        !(stored instanceof Uint8Array) ||
        !fingerprint.equals(Buffer.from(stored))
      )
        throw new Error("Event ID reused with different content");
      return false;
    }
    if (runRef) {
      const run = this.db
        .prepare(
          "SELECT status FROM runs WHERE ordinal = ? AND session_ref = ?",
        )
        .get(runRef, binding.sessionRef);
      if (!run || text(run, "status") !== "running")
        throw new Error("Cannot append to a closed or foreign Run");
    }
    const result = this.db
      .prepare(
        "INSERT INTO events (id, session_ref, run_ref, branch_ref, kind, captured_at, message_id, payload, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        binding.sessionRef,
        runRef,
        binding.branchRef,
        event.kind,
        Date.parse(event.at),
        event.message?.id ?? null,
        payload,
        fingerprint,
      );
    if (event.message) {
      const message = event.message;
      if (this.db.prepare("SELECT 1 FROM messages WHERE id=?").get(message.id))
        throw new Error("Cannot change a terminal or foreign message");
      // Encoded media leaves the row before anything measures or compresses it.
      const body = externalize(message.payload, this.blobs);
      const { blob, dictId } = encode(json(body), this.writeDictionary);
      this.db
        .prepare(
          "INSERT INTO messages (id, session_ref, run_ref, branch_ref, role, first_seq, payload, dict_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          message.id,
          binding.sessionRef,
          runRef,
          binding.branchRef,
          message.role,
          result.lastInsertRowid,
          blob,
          dictId,
        );
      if (runRef && message.role === "user") {
        const goal = textBodies(body).join("\n").slice(0, 512);
        this.db
          .prepare("UPDATE runs SET goal = ? WHERE ordinal = ? AND goal = ''")
          .run(goal, runRef);
      }
      // Counting rows is a scan, so the growth check rides a local counter and
      // only reaches the database on the cadence a rebuild could matter at.
      if (++this.sinceDictionaryCheck >= DICTIONARY_CHECK_INTERVAL) {
        this.sinceDictionaryCheck = 0;
        const refreshed = refreshDictionary(
          this.db,
          this.dictionaries,
          event.at,
        );
        if (refreshed?.id !== this.writeDictionary?.id) {
          this.writeDictionary = refreshed;
          this.dictionaries = openDictionaries(this.db);
        }
      }
    }
    this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE ref = ?")
      .run(event.at, binding.sessionRef);
    return true;
  }

  private finishRun(runRef: number, endedAt: string | null, at: string): void {
    // 'completed' only means recording stopped, not that the work succeeded.
    this.db
      .prepare(
        "UPDATE runs SET status = 'completed', ended_at = ?, updated_at = ?, reason = NULL WHERE ordinal = ? AND status = 'running'",
      )
      .run(endedAt, at, runRef);
  }

  private recoverRunning(binding: Binding, reason: string, at: string): void {
    const active = this.db
      .prepare(
        "SELECT ordinal, branch_ref FROM runs WHERE session_ref = ? AND status = 'running'",
      )
      .get(binding.sessionRef);
    if (active) {
      const ordinal = integer(active, "ordinal");
      this.insertEvent(
        { ...binding, branchRef: integer(active, "branch_ref") },
        ordinal,
        {
          id: randomUUID(),
          kind: "archive.recording_stopped",
          at,
          payload: { reason },
        },
      );
      // We observed recording stop, not the original execution's end time.
      this.finishRun(ordinal, null, at);
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
      const created = this.db
        .prepare(
          "INSERT INTO branches (id, session_ref, previous_branch_ref, source_target_hint, reason, created_at) VALUES (?, ?, ?, ?, 'tree_navigation', ?) RETURNING ref",
        )
        .get(
          randomUUID(),
          binding.sessionRef,
          binding.branchRef,
          targetHint,
          event.at,
        );
      const next = { ...binding, branchRef: Number(created?.ref) };
      this.insertEvent(next, null, event);
      return next;
    });
  }

  rename(binding: Binding, name: string | null): void {
    this.transaction(() => {
      this.assertWriter(binding);
      this.db
        .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE ref = ?")
        .run(name, new Date().toISOString(), binding.sessionRef);
    });
  }

  detach(binding: Binding, reason: string): void {
    this.transaction(() => {
      this.assertWriter(binding);
      this.recoverRunning(binding, reason, new Date().toISOString());
      this.db
        .prepare("DELETE FROM writers WHERE session_ref = ? AND token = ?")
        .run(binding.sessionRef, binding.token);
    });
  }

  /** Decodes a stored message payload into JSON text. */
  payloadText(payload: unknown, dictId: unknown): string {
    return decodeRow(payload, dictId, this.dictionaries);
  }

  runs(sessionRef: number, afterNumber = 0, limit = 50) {
    this.checkPage(afterNumber, limit);
    return this.db
      .prepare(
        "SELECT * FROM runs WHERE session_ref = ? AND number > ? ORDER BY number LIMIT ?",
      )
      .all(sessionRef, afterNumber, limit)
      .map(runFromRow);
  }

  run(sessionRef: number, number: number) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("Run number must be a positive safe integer");
    const row = this.db
      .prepare("SELECT * FROM runs WHERE session_ref = ? AND number = ?")
      .get(sessionRef, number);
    return row ? runFromRow(row) : null;
  }

  events(sessionRef: number, runRef: number | null, after = 0, limit = 50) {
    this.checkPage(after, limit);
    return this.db
      .prepare(
        "SELECT * FROM events WHERE session_ref = ? AND (? IS NULL OR run_ref = ?) AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(sessionRef, runRef, runRef, after, limit)
      .map((row) => ({
        sequence: integer(row, "seq"),
        id: text(row, "id"),
        runRef: row.run_ref === null ? null : integer(row, "run_ref"),
        branchRef: integer(row, "branch_ref"),
        kind: text(row, "kind"),
        capturedAt: new Date(integer(row, "captured_at")).toISOString(),
        messageId: nullableText(row, "message_id"),
        payload: parse(text(row, "payload")),
      }));
  }

  messages(sessionRef: number, runRef: number | null, after = 0, limit = 50) {
    this.checkPage(after, limit);
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE session_ref = ? AND (? IS NULL OR run_ref = ?) AND first_seq > ? ORDER BY first_seq LIMIT ?",
      )
      .all(sessionRef, runRef, runRef, after, limit)
      .map((row) => ({
        id: text(row, "id"),
        runRef: row.run_ref === null ? null : integer(row, "run_ref"),
        branchRef: integer(row, "branch_ref"),
        role: text(row, "role"),
        sequence: integer(row, "first_seq"),
        payload: parse(this.payloadText(row.payload, row.dict_id)),
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
