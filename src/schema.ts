import type { DatabaseSync } from "node:sqlite";

// RUN2. Check identity before journal-mode changes or any schema/data writes.
const APPLICATION_ID = 0x52554e32;
export const SCHEMA_VERSION = 2;

/** v1 stored one Run's worth of identity on every event row: four UUIDs, a
 *  64-character hex fingerprint and an ISO timestamp, against payloads
 *  averaging well under 200 bytes, then replicated the UUIDs through three
 *  indexes. v2 points events at the integer keys the referenced rows already
 *  have. The identifiers only ever have to be unique inside one local SQLite
 *  file, so the text forms bought nothing.
 *
 *  Message payloads move from TEXT to a compressed BLOB with the id of the
 *  dictionary they were written against. */
export function validateDatabase(db: DatabaseSync): void {
  const app = db.prepare("PRAGMA application_id").get()?.application_id;
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  const occupied = db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
  if (app === APPLICATION_ID && (version === 1 || version === SCHEMA_VERSION))
    return;
  if (app === 0 && version === 0 && !occupied) return;
  throw new Error(
    "Not a supported pi-experiencev2 database. Use a separate empty database.",
  );
}

const CREATE_V2 = `
  CREATE TABLE sessions (
    ref INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE, pi_session_id TEXT NOT NULL, cwd TEXT NOT NULL,
    title TEXT, agent_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(pi_session_id, cwd)
  ) STRICT;
  CREATE INDEX sessions_cwd ON sessions(cwd);
  CREATE TABLE branches (
    ref INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE, session_ref INTEGER NOT NULL REFERENCES sessions(ref),
    previous_branch_ref INTEGER REFERENCES branches(ref), source_target_hint TEXT,
    reason TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(ref, session_ref)
  ) STRICT;
  CREATE TABLE runs (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE, session_ref INTEGER NOT NULL REFERENCES sessions(ref),
    branch_ref INTEGER NOT NULL, number INTEGER NOT NULL, agent_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted','recovery_required')),
    started_at TEXT NOT NULL, ended_at TEXT, updated_at TEXT NOT NULL, reason TEXT,
    overview TEXT, summary_error TEXT, goal TEXT NOT NULL DEFAULT '',
    UNIQUE(session_ref, number), UNIQUE(ordinal, session_ref),
    FOREIGN KEY(branch_ref, session_ref) REFERENCES branches(ref, session_ref)
  ) STRICT;
  CREATE UNIQUE INDEX one_running_run ON runs(session_ref) WHERE status='running';
  CREATE INDEX runs_time ON runs(started_at);
  CREATE INDEX runs_session ON runs(session_ref, ordinal);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    session_ref INTEGER NOT NULL REFERENCES sessions(ref),
    run_ref INTEGER, branch_ref INTEGER NOT NULL,
    kind TEXT NOT NULL, captured_at INTEGER NOT NULL, message_id TEXT,
    payload TEXT NOT NULL CHECK(json_valid(payload)), fingerprint BLOB NOT NULL,
    FOREIGN KEY(run_ref, session_ref) REFERENCES runs(ordinal, session_ref),
    FOREIGN KEY(branch_ref, session_ref) REFERENCES branches(ref, session_ref)
  ) STRICT;
  CREATE INDEX events_run ON events(run_ref, seq);
  CREATE INDEX events_session ON events(session_ref, seq);
  CREATE TABLE dicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bytes BLOB NOT NULL,
    created_at TEXT NOT NULL, rows_at_build INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_ref INTEGER NOT NULL REFERENCES sessions(ref),
    run_ref INTEGER, branch_ref INTEGER NOT NULL, role TEXT NOT NULL,
    first_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
    -- dict_id NULL marks a payload held as raw UTF-8 JSON, 0 marks zstd with no
    -- dictionary, and a positive value names a row in dicts. The two sentinels
    -- are not dictionary rows, so this is deliberately not a foreign key;
    -- dictionaries are only ever appended, never deleted.
    payload BLOB NOT NULL, dict_id INTEGER,
    FOREIGN KEY(run_ref, session_ref) REFERENCES runs(ordinal, session_ref),
    FOREIGN KEY(branch_ref, session_ref) REFERENCES branches(ref, session_ref)
  ) STRICT;
  CREATE INDEX messages_run ON messages(run_ref, first_seq);
  CREATE INDEX messages_session ON messages(session_ref, first_seq);
  CREATE TABLE writers (
    session_ref INTEGER PRIMARY KEY REFERENCES sessions(ref),
    token TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE deleted_runs (
    ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, deleted_at TEXT NOT NULL, reason TEXT NOT NULL
  ) STRICT;
`;

export function initialize(db: DatabaseSync): void {
  validateDatabase(db);
  const current = db.prepare("PRAGMA user_version").get()?.user_version;
  if (current === SCHEMA_VERSION) return;
  // Deleting a Run should return its pages to the filesystem rather than leave
  // them as free space inside a file that only ever grows. The mode is fixed
  // when the first table is created, so it is set before any of them exist and
  // outside the transaction, where SQLite ignores it.
  if (current === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  db.exec("BEGIN IMMEDIATE");
  try {
    validateDatabase(db);
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 0) {
      db.exec(CREATE_V2);
      db.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    } else if (version === 1) {
      migrateV1ToV2(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (current === 1) {
    // The rewrite leaves the v1 pages free. Changing auto_vacuum on a populated
    // file needs a full VACUUM, which is also what hands those pages back.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    db.exec("VACUUM;");
  }
}

/** Rewrites v1 rows into the v2 tables. Migrated messages keep their existing
 *  JSON text and are marked raw with a NULL dict_id, so startup costs one pass
 *  over the rows rather than recompressing the whole archive. The store
 *  compresses new writes; history is recompressed by a later maintenance pass. */
function migrateV1ToV2(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE sessions RENAME TO sessions_v1;
    ALTER TABLE branches RENAME TO branches_v1;
    ALTER TABLE runs RENAME TO runs_v1;
    ALTER TABLE events RENAME TO events_v1;
    ALTER TABLE messages RENAME TO messages_v1;
    ALTER TABLE writers RENAME TO writers_v1;
    ALTER TABLE deleted_runs RENAME TO deleted_runs_v1;
    DROP INDEX IF EXISTS sessions_cwd;
    DROP INDEX IF EXISTS one_running_run;
    DROP INDEX IF EXISTS runs_time;
    DROP INDEX IF EXISTS runs_session;
    DROP INDEX IF EXISTS events_run;
    DROP INDEX IF EXISTS events_session;
    DROP INDEX IF EXISTS messages_run;
    DROP INDEX IF EXISTS messages_session;
  `);
  db.exec(CREATE_V2);
  db.exec(`
    INSERT INTO sessions (id, pi_session_id, cwd, title, agent_id, created_at, updated_at)
      SELECT id, pi_session_id, cwd, title, agent_id, created_at, updated_at
      FROM sessions_v1 ORDER BY rowid;
    INSERT INTO branches (id, session_ref, previous_branch_ref, source_target_hint, reason, created_at)
      SELECT b.id, s.ref, NULL, b.source_target_hint, b.reason, b.created_at
      FROM branches_v1 b
      JOIN sessions s ON s.id = b.session_id
      ORDER BY b.rowid;
    INSERT INTO runs (ordinal, id, session_ref, branch_ref, number, agent_id, status,
                      started_at, ended_at, updated_at, reason, overview, summary_error, goal)
      SELECT r.ordinal, r.id, s.ref, b.ref, r.number, r.agent_id, r.status,
             r.started_at, r.ended_at, r.updated_at, r.reason, r.overview, r.summary_error, r.goal
      FROM runs_v1 r
      JOIN sessions s ON s.id = r.session_id
      JOIN branches b ON b.id = r.branch_id
      ORDER BY r.ordinal;
    INSERT INTO events (seq, id, session_ref, run_ref, branch_ref, kind, captured_at,
                        message_id, payload, fingerprint)
      SELECT e.seq, e.id, s.ref, r.ordinal, b.ref, e.kind,
             CAST(ROUND((julianday(e.captured_at) - 2440587.5) * 86400000) AS INTEGER),
             e.message_id, e.payload, unhex(substr(e.fingerprint, 1, 16))
      FROM events_v1 e
      JOIN sessions s ON s.id = e.session_id
      JOIN branches b ON b.id = e.branch_id
      LEFT JOIN runs_v1 r ON r.id = e.run_id
      ORDER BY e.seq;
    INSERT INTO messages (id, session_ref, run_ref, branch_ref, role, first_seq, payload, dict_id)
      SELECT m.id, s.ref, r.ordinal, b.ref, m.role, m.first_seq, CAST(m.payload AS BLOB), NULL
      FROM messages_v1 m
      JOIN sessions s ON s.id = m.session_id
      JOIN branches b ON b.id = m.branch_id
      LEFT JOIN runs_v1 r ON r.id = m.run_id
      ORDER BY m.first_seq;
    INSERT INTO deleted_runs SELECT * FROM deleted_runs_v1;
  `);
  // Resolved after every branch exists, because a branch may precede its parent
  // in rowid order and an INSERT..SELECT cannot join rows it is still writing.
  db.exec(`
    UPDATE branches SET previous_branch_ref = (
      SELECT p.ref FROM branches_v1 v JOIN branches p ON p.id = v.previous_branch_id
      WHERE v.id = branches.id
    );
  `);
  // Writers are live leases, not history. A migrating process holds none of the
  // old ones, and every session re-attaches on its next start.
  db.exec(`
    DROP TABLE writers_v1;
    DROP TABLE messages_v1;
    DROP TABLE events_v1;
    DROP TABLE runs_v1;
    DROP TABLE branches_v1;
    DROP TABLE sessions_v1;
    DROP TABLE deleted_runs_v1;
  `);
}
