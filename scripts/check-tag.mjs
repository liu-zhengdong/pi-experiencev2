import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(
  process.argv[2],
  `v${version}`,
  "Release tag must match package.json version",
);
console.log(`Release tag verified: v${version}`);
