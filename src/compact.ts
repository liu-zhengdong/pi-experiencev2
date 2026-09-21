import { externalize } from "./blobs.ts";
import { buildDictionary, decodeRow, encode } from "./codec.ts";
import { json, parse } from "./data.ts";
import type { RunStore } from "./store.ts";

/** Migration leaves existing messages exactly as v1 wrote them: raw JSON with
 *  encoded media inline. Rewriting an entire archive is far too slow to sit in
 *  a session's startup path, so it is a separate pass the user asks for.
 *
 *  The pass is resumable and safe to interrupt. Each batch is its own
 *  transaction, and a row is only rewritten when the result decodes back to
 *  what was there, so stopping halfway leaves a mixed archive that reads
 *  exactly the same as a finished one. */

const BATCH = 500;

export type CompactProgress = {
  done: number;
  total: number;
  bytesBefore: number;
  bytesAfter: number;
};

/** Rewrites raw messages into externalized, compressed form.
 *  `onProgress` is called after each committed batch. */
export function compact(
  store: RunStore,
  onProgress?: (progress: CompactProgress) => void,
): CompactProgress {
  const db = store.db;
  const total = Number(
    db.prepare("SELECT count(*) AS n FROM messages WHERE dict_id IS NULL").get()
      ?.n ?? 0,
  );
  const progress: CompactProgress = {
    done: 0,
    total,
    bytesBefore: 0,
    bytesAfter: 0,
  };
  if (!total) return progress;

  // Built once from the archive's own content so every rewritten row shares it.
  const dictionary = ensureDictionary(store);

  const select = db.prepare(
    "SELECT id, payload, dict_id FROM messages WHERE dict_id IS NULL ORDER BY first_seq LIMIT ?",
  );
  const update = db.prepare(
    "UPDATE messages SET payload=?, dict_id=? WHERE id=?",
  );
  for (;;) {
    const rows = select.all(BATCH);
    if (!rows.length) break;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const id = String(row.id);
        const text = decodeRow(row.payload, row.dict_id, store.dictionaries);
        const before = Buffer.byteLength(text);
        const body = externalize(parse(text), store.blobs);
        const { blob, dictId } = encode(json(body), dictionary);
        update.run(blob, dictId, id);
        progress.done++;
        progress.bytesBefore += before;
        progress.bytesAfter += blob.length;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    onProgress?.({ ...progress });
  }
  // Rewritten rows leave their old pages free, and the blobs they replaced were
  // the bulk of the file. Hand that space back rather than reserving it.
  db.exec("VACUUM;");
  return progress;
}

function ensureDictionary(store: RunStore): { id: number; bytes: Buffer } {
  const existing = store.dictionaries.current;
  if (existing) return existing;
  const sample = store.db
    .prepare("SELECT payload, dict_id FROM messages ORDER BY first_seq LIMIT ?")
    .all(5000)
    .map((row) => decodeRow(row.payload, row.dict_id, store.dictionaries));
  const bytes = buildDictionary(sample);
  const row = store.db
    .prepare(
      "INSERT INTO dicts (bytes, created_at, rows_at_build) VALUES (?, ?, ?) RETURNING id",
    )
    .get(bytes, new Date().toISOString(), sample.length);
  const built = { id: Number(row?.id), bytes };
  store.reloadDictionaries();
  return built;
}
