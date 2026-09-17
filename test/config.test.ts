import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_FILE_NAME, loadConfig } from "../src/config.ts";

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "runs-config-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir: string, content: string): void {
  writeFileSync(join(dir, CONFIG_FILE_NAME), content);
}

test("missing config file yields empty config", () => {
  withDir((dir) => assert.deepEqual(loadConfig(dir), {}));
});

test("valid config file parses all keys", () => {
  withDir((dir) => {
    write(
      dir,
      JSON.stringify({
        db: "/tmp/x.sqlite",
        noSummary: true,
        overviewLimit: 500,
      }),
    );
    assert.deepEqual(loadConfig(dir), {
      db: "/tmp/x.sqlite",
      noSummary: true,
      overviewLimit: 500,
    });
  });
});

test("unknown keys are ignored, partial config is fine", () => {
  withDir((dir) => {
    write(dir, '{"overviewLimit":300,"futureOption":true}');
    assert.deepEqual(loadConfig(dir), { overviewLimit: 300 });
  });
});

test("malformed config files throw explicit errors", () => {
  withDir((dir) => {
    for (const [content, pattern] of [
      ["{broken", /不是有效 JSON/],
      ['"text"', /必须是 JSON 对象/],
      ["[1]", /必须是 JSON 对象/],
      ['{"db":123}', /db 必须是非空字符串/],
      ['{"db":"  "}', /db 必须是非空字符串/],
      ['{"noSummary":"yes"}', /noSummary 必须是布尔值/],
      ['{"overviewLimit":"500"}', /overviewLimit 必须是数字/],
    ] as const) {
      write(dir, content);
      assert.throws(() => loadConfig(dir), pattern);
    }
  });
});
