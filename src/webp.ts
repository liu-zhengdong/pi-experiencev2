import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Once media lives in files, those files are the larger half of the archive's
 *  disk, and PNG is the most expensive way to keep them. Re-encoded as lossless
 *  WebP, the 422 distinct screenshots in a real week came to 42% of their PNG
 *  bytes — 48 MB down to 20 MB — with every pixel preserved.
 *
 *  The encoder is libwebp's `cwebp`, used only when it is already on PATH. This
 *  package has no runtime dependencies, and an image codec is too much to take
 *  on for a disk saving. An archive written without cwebp keeps its PNGs and
 *  reads exactly like one written with it, because every stored reference
 *  carries the media type of the bytes actually in the file. */

/** Lossless at the default effort. `-z 9` reaches 39% but takes 1.9 s an image
 *  against 0.25 s, which is not a trade a recording session should make. */
const ARGUMENTS = ["-quiet", "-lossless"];

/** An encoder that hangs must not take the session down with it. */
const TIMEOUT_MS = 10_000;

/** cwebp reads and writes files; it accepts neither stdin nor stdout. One
 *  directory per process is enough, since a capture is never re-entered. */
let scratch: string | null = null;
let installed: boolean | null = null;

function available(): boolean {
  if (installed === null)
    try {
      installed =
        spawnSync("cwebp", ["-version"], { timeout: TIMEOUT_MS }).status === 0;
    } catch {
      installed = false;
    }
  return installed;
}

/** Re-encodes PNG bytes as lossless WebP, or returns null to keep the original:
 *  no encoder, another format, or a result that did not come out smaller. */
export function toWebp(bytes: Buffer, mimeType: string): Buffer | null {
  if (mimeType !== "image/png" || !available()) return null;
  scratch ??= mkdtempSync(join(tmpdir(), "pi-runs-webp-"));
  const source = join(scratch, "source.png");
  const target = join(scratch, "target.webp");
  try {
    writeFileSync(source, bytes, { mode: 0o600 });
    const run = spawnSync("cwebp", [...ARGUMENTS, source, "-o", target], {
      timeout: TIMEOUT_MS,
    });
    if (run.status !== 0) return null;
    const encoded = readFileSync(target);
    return encoded.length < bytes.length ? encoded : null;
  } catch {
    // A failed re-encode costs the saving, never the capture.
    return null;
  } finally {
    rmSync(source, { force: true });
    rmSync(target, { force: true });
  }
}
