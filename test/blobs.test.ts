import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { BlobStore, externalize, isBlobRef } from "../src/blobs.ts";
import { workspace } from "./helpers.ts";

/** A real PNG, large enough to be worth a file and varied enough that WebP has
 *  something to win on. Built here rather than committed so the test carries no
 *  binary fixture. */
function png(size = 96): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let at = 0;
  for (let y = 0; y < size; y++) {
    raw[at++] = 0; // no per-row filter
    for (let x = 0; x < size; x++) {
      raw[at++] = (x * 5) & 0xff;
      raw[at++] = (y * 3) & 0xff;
      raw[at++] = (x ^ y) & 0xff;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function block(bytes: Buffer, mimeType = "image/png") {
  return { type: "image", data: bytes.toString("base64"), mimeType };
}

function stored(payload: unknown): {
  ref: string;
  mimeType: string;
  bytes: number;
  data?: unknown;
} {
  const [image] = (payload as { content: unknown[] }).content;
  return image as { ref: string; mimeType: string; bytes: number };
}

const haveEncoder =
  spawnSync("cwebp", ["-version"], { timeout: 10_000 }).status === 0;

test("media moves to a file the reference can be verified against", (t) => {
  const f = workspace(t);
  const store = new BlobStore(join(f.directory, "blobs"));
  const source = png();
  assert.ok(source.length > 1024);

  const result = stored(externalize({ content: [block(source)] }, store));
  assert.ok(isBlobRef(result.ref), result.ref);
  assert.equal(result.data, undefined);

  const file = store.read(result.ref as `sha256-${string}`, result.mimeType);
  assert.equal(file.length, result.bytes);
  // The name of a blob is the digest of what is in it, whatever wrote it.
  assert.equal(
    result.ref,
    `sha256-${createHash("sha256").update(file).digest("hex")}`,
  );

  if (haveEncoder) {
    assert.equal(result.mimeType, "image/webp");
    assert.equal(file.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(file.subarray(8, 12).toString("ascii"), "WEBP");
    assert.ok(
      file.length < source.length,
      `${file.length} vs ${source.length}`,
    );
  } else {
    assert.equal(result.mimeType, "image/png");
    assert.deepEqual(file, source);
  }
});

test("what the encoder cannot take is stored as it arrived", (t) => {
  const f = workspace(t);
  const store = new BlobStore(join(f.directory, "blobs"));
  // Each of these must survive intact: bytes that claim to be a PNG and are
  // not, a format cwebp does not read, and an unknown type.
  const damaged = Buffer.concat([png().subarray(0, 40), Buffer.alloc(2048, 7)]);
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.alloc(2048, 0x41),
  ]);
  for (const [bytes, mimeType] of [
    [damaged, "image/png"],
    [pdf, "application/pdf"],
    [pdf, "application/octet-stream"],
  ] as const) {
    const result = stored(
      externalize({ content: [block(bytes, mimeType)] }, store),
    );
    assert.equal(result.mimeType, mimeType, mimeType);
    assert.deepEqual(
      store.read(result.ref as `sha256-${string}`, result.mimeType),
      bytes,
      mimeType,
    );
  }
});

test("small media stays in the message, and identical media shares one file", (t) => {
  const f = workspace(t);
  const store = new BlobStore(join(f.directory, "blobs"));
  const tiny = stored(
    externalize({ content: [block(Buffer.alloc(300, 1))] }, store),
  );
  assert.equal(tiny.ref, undefined);
  assert.ok(tiny.data);

  const source = png();
  const first = stored(externalize({ content: [block(source)] }, store));
  const second = stored(externalize({ content: [block(source)] }, store));
  assert.equal(first.ref, second.ref);
  const path = join(
    store.dir,
    first.ref.slice(7, 9),
    `${first.ref.slice(9)}.${first.mimeType.split("/")[1]}`,
  );
  assert.equal(readFileSync(path).length, first.bytes);
});
