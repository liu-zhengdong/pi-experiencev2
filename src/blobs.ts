import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { toWebp } from "./webp.ts";

/** Encoded media is the largest thing an archive stores and the one thing it
 *  never reads back through a text path: search matches only text blocks, and
 *  both message projections render media as a placeholder. Held inline, a
 *  screenshot is re-read and re-parsed by every content scan that passes over
 *  its Run, and pays a third again in size for base64.
 *
 *  So the bytes live in files beside the database, addressed by their own
 *  digest, and the message keeps a reference. Identical captures collapse onto
 *  one file, and the scan path sees a payload it can actually use. */

/** Below this an inline string costs less than the file it would occupy. */
const MINIMUM_BYTES = 1024;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

export type BlobRef = `sha256-${string}`;

export function isBlobRef(value: unknown): value is BlobRef {
  return typeof value === "string" && /^sha256-[0-9a-f]{64}$/.test(value);
}

export class BlobStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private location(ref: BlobRef, extension: string): string {
    const hex = ref.slice("sha256-".length);
    return join(this.dir, hex.slice(0, 2), `${hex.slice(2)}.${extension}`);
  }

  /** Writes the bytes unless an identical digest is already present. */
  put(bytes: Buffer, mimeType: string): BlobRef {
    const hex = createHash("sha256").update(bytes).digest("hex");
    const ref: BlobRef = `sha256-${hex}`;
    const path = this.location(ref, EXTENSIONS[mimeType] ?? "bin");
    try {
      if (statSync(path).size === bytes.length) return ref;
    } catch {
      // Absent, or unreadable; either way fall through and write it.
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Rename into place so a reader never observes a partially written blob.
    const pending = `${path}.${process.pid}.pending`;
    writeFileSync(pending, bytes, { mode: 0o600 });
    renameSync(pending, path);
    return ref;
  }

  read(ref: BlobRef, mimeType: string): Buffer {
    return readFileSync(this.location(ref, EXTENSIONS[mimeType] ?? "bin"));
  }
}

type ImageBlock = {
  type: string;
  data?: unknown;
  ref?: unknown;
  mimeType?: unknown;
};

function externalizeBlock(block: ImageBlock, store: BlobStore): unknown {
  const { data, mimeType } = block;
  if (typeof data !== "string" || data.length < MINIMUM_BYTES) return block;
  const media =
    typeof mimeType === "string" ? mimeType : "application/octet-stream";
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
    if (!bytes.length) return block;
  } catch {
    return block;
  }
  // Same pixels, less than half the disk, where an encoder is available.
  const encoded = toWebp(bytes, media);
  const stored = encoded ?? bytes;
  const storedType = encoded ? "image/webp" : media;
  let ref: BlobRef;
  try {
    ref = store.put(stored, storedType);
  } catch {
    // A blob that cannot be written must not cost the message. Recording the
    // payload inline keeps the Run complete; the next capture retries the file.
    return block;
  }
  const { data: _dropped, ...rest } = block;
  // The reference names the digest of what is in the file, and the media type
  // describes it, so a reader never has to know which encoder wrote the Run.
  return { ...rest, ref, mimeType: storedType, bytes: stored.length };
}

/** Rewrites encoded media in a message payload into blob references. */
export function externalize(payload: unknown, store: BlobStore): unknown {
  if (Array.isArray(payload))
    return payload.map((item) => externalize(item, store));
  if (payload === null || typeof payload !== "object") return payload;
  const block = payload as ImageBlock;
  if (typeof block.data === "string") return externalizeBlock(block, store);
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      externalize(value, store),
    ]),
  );
}
