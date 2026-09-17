import type { DatabaseSync } from "node:sqlite";

// RUN2. Check identity before journal-mode changes or any schema/data writes.
const APPLICATION_ID = 0x52554e32;
export function validateDatabase(db: DatabaseSync): void {
  const app = db.prepare("PRAGMA application_id").get()?.application_id;
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  const occupied = db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
  if (app === APPLICATION_ID && version === 1) return;
  if (app === 0 && version === 0 && !occupied) return;
  throw new Error(
    "Not a supported pi-experiencev2 database. Use a separate empty database; v1 archives are never migrated.",
  );
}

export function initialize(db: DatabaseSync): void {
  validateDatabase(db);
  if (db.prepare("PRAGMA user_version").get()?.user_version === 1) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    validateDatabase(db);
    if (db.prepare("PRAGMA user_version").get()?.user_version === 0) {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, pi_session_id TEXT NOT NULL, cwd TEXT NOT NULL,
          title TEXT, agent_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(pi_session_id, cwd)
        ) STRICT;
        CREATE INDEX sessions_cwd ON sessions(cwd);
        CREATE TABLE branches (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
          previous_branch_id TEXT REFERENCES branches(id), source_target_hint TEXT,
          reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(id, session_id)
        ) STRICT;
        CREATE TABLE runs (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id),
          branch_id TEXT NOT NULL, number INTEGER NOT NULL, agent_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted','recovery_required')),
          started_at TEXT NOT NULL, ended_at TEXT, updated_at TEXT NOT NULL, reason TEXT,
          overview TEXT, summary_error TEXT, goal TEXT NOT NULL DEFAULT '',
          UNIQUE(session_id, number), UNIQUE(id, session_id),
          FOREIGN KEY(branch_id, session_id) REFERENCES branches(id, session_id)
        ) STRICT;
        CREATE UNIQUE INDEX one_running_run ON runs(session_id) WHERE status='running';
        CREATE INDEX runs_time ON runs(started_at);
        CREATE INDEX runs_session ON runs(session_id, ordinal);
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT, branch_id TEXT NOT NULL,
          kind TEXT NOT NULL, captured_at TEXT NOT NULL, message_id TEXT,
          payload TEXT NOT NULL CHECK(json_valid(payload)), fingerprint TEXT NOT NULL,
          FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id),
          FOREIGN KEY(branch_id, session_id) REFERENCES branches(id, session_id)
        ) STRICT;
        CREATE INDEX events_run ON events(run_id, seq);
        CREATE INDEX events_session ON events(session_id, seq);
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
          run_id TEXT, branch_id TEXT NOT NULL, role TEXT NOT NULL,
          first_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
          payload TEXT NOT NULL CHECK(json_valid(payload)),
          FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id),
          FOREIGN KEY(branch_id, session_id) REFERENCES branches(id, session_id)
        ) STRICT;
        CREATE INDEX messages_run ON messages(run_id, first_seq);
        CREATE INDEX messages_session ON messages(session_id, first_seq);
        CREATE TABLE writers (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id), token TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE deleted_runs (
          ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, deleted_at TEXT NOT NULL, reason TEXT NOT NULL
        ) STRICT;
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = 1;
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
