import type { DatabaseSync } from "node:sqlite";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

/** Message payloads are JSON text with heavily repeated structure: the same role
 *  names, tool names, argument keys and absolute paths recur across every Run.
 *  Compressing each row on its own recovers little of that, because a single row
 *  is too short to build a useful window. A dictionary shared by all rows lets
 *  each row reference the repeated material instead of restating it.
 *
 *  The dictionary is built from the archive's own payloads, stored alongside
 *  them, and never modified. Rewriting a dictionary would make every row that
 *  used it unreadable, so a refreshed dictionary is always a new row with a new
 *  id, and existing messages keep pointing at the one they were written with. */

const LEVEL = { [constants.ZSTD_c_compressionLevel]: 19 };

/** Below this, the archive has not yet shown enough of its own shape to build a
 *  dictionary from. Those rows are written as plain zstd and stay that way. */
const FIRST_DICTIONARY_AT = 500;

/** A dictionary is rebuilt only after the archive has grown by this factor,
 *  which bounds the number of live dictionaries to the logarithm of the row
 *  count rather than letting it grow with the archive. */
const REBUILD_GROWTH_FACTOR = 10;

const DICTIONARY_BYTES = 16 * 1024;
const SAMPLE_ROWS = 400;
const SAMPLE_HEAD_BYTES = 400;

export type Dictionaries = {
  /** Dictionary to write new rows with; undefined means write plain zstd. */
  current?: { id: number; bytes: Buffer };
  get(id: number): Buffer;
};

/** Concatenated payload heads, tail-trimmed to the dictionary budget.
 *
 *  zstd accepts any buffer as a dictionary, so the sample is used directly
 *  rather than run through zstd's dictionary trainer: the trainer is not
 *  exposed by node:zlib, and measured against it on this archive's own data a
 *  raw sample costs about one percentage point of ratio (42.6% vs 41.6%).
 *  Spreading the sample across the row order keeps it representative of the
 *  whole archive instead of whichever period happens to be densest. */
export function buildDictionary(payloads: string[]): Buffer {
  if (!payloads.length) return Buffer.alloc(0);
  const step = Math.max(1, Math.floor(payloads.length / SAMPLE_ROWS));
  const parts: string[] = [];
  for (let i = 0; i < payloads.length; i += step)
    parts.push((payloads[i] ?? "").slice(0, SAMPLE_HEAD_BYTES));
  return Buffer.from(parts.join("").slice(-DICTIONARY_BYTES), "utf8");
}

export function encode(
  payload: string,
  dictionary: { id: number; bytes: Buffer } | undefined,
): { blob: Buffer; dictId: number } {
  const source = Buffer.from(payload, "utf8");
  return {
    blob: dictionary
      ? zstdCompressSync(source, {
          dictionary: dictionary.bytes,
          params: LEVEL,
        })
      : zstdCompressSync(source, { params: LEVEL }),
    dictId: dictionary?.id ?? 0,
  };
}

/** A null dictionary id marks a payload written before compression, or carried
 *  over by the v1 migration, and is returned as stored. */
export function decode(
  blob: Uint8Array,
  dictId: number | null,
  dictionaries: Dictionaries,
): string {
  const source = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (dictId === null) return source.toString("utf8");
  const bytes = dictId
    ? zstdDecompressSync(source, { dictionary: dictionaries.get(dictId) })
    : zstdDecompressSync(source);
  return bytes.toString("utf8");
}

/** Reads a stored payload column pair back into JSON text. */
export function decodeRow(
  payload: unknown,
  dictId: unknown,
  dictionaries: Dictionaries,
): string {
  if (typeof payload === "string") return payload;
  if (!(payload instanceof Uint8Array))
    throw new Error("Archived message payload is neither text nor bytes");
  return decode(
    payload,
    dictId === null || dictId === undefined ? null : Number(dictId),
    dictionaries,
  );
}

/** Dictionaries are immutable and few, so they are read once and held. */
export function openDictionaries(db: DatabaseSync): Dictionaries {
  const cache = new Map<number, Buffer>();
  const load = (id: number): Buffer => {
    const cached = cache.get(id);
    if (cached) return cached;
    const row = db.prepare("SELECT bytes FROM dicts WHERE id=?").get(id);
    const bytes = row?.bytes;
    if (!(bytes instanceof Uint8Array))
      throw new Error(
        `Archive is missing compression dictionary ${id}; the messages written with it cannot be read`,
      );
    const buffer = Buffer.from(bytes);
    cache.set(id, buffer);
    return buffer;
  };
  const newest = db
    .prepare("SELECT id FROM dicts ORDER BY id DESC LIMIT 1")
    .get();
  const currentId = newest ? Number(newest.id) : 0;
  return {
    ...(currentId
      ? { current: { id: currentId, bytes: load(currentId) } }
      : {}),
    get: load,
  };
}

/** Builds the next dictionary when the archive has grown enough to warrant one.
 *  Returns the dictionary new rows should use, which is the existing one when
 *  nothing was built. Callers run this inside their own transaction. */
export function refreshDictionary(
  db: DatabaseSync,
  dictionaries: Dictionaries,
  at: string,
): { id: number; bytes: Buffer } | undefined {
  const total = Number(
    db.prepare("SELECT count(*) AS n FROM messages").get()?.n ?? 0,
  );
  if (total < FIRST_DICTIONARY_AT) return dictionaries.current;
  const built = db
    .prepare("SELECT rows_at_build FROM dicts ORDER BY id DESC LIMIT 1")
    .get();
  if (built && total < Number(built.rows_at_build) * REBUILD_GROWTH_FACTOR)
    return dictionaries.current;
  const sample = db
    .prepare("SELECT payload, dict_id FROM messages ORDER BY first_seq LIMIT ?")
    .all(5000)
    .map((row) => decodeRow(row.payload, row.dict_id, dictionaries));
  const bytes = buildDictionary(sample);
  if (!bytes.length) return dictionaries.current;
  const id = db
    .prepare(
      "INSERT INTO dicts (bytes, created_at, rows_at_build) VALUES (?, ?, ?) RETURNING id",
    )
    .get(bytes, at, total);
  return { id: Number(id?.id), bytes };
}
