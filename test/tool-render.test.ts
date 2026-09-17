import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initTheme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  stripTerminalSequences,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { findDetails } from "../src/tool-render.ts";
import { assistant, toolCall } from "./helpers.ts";
import { sdkFixture } from "./sdk-helper.ts";

function card(definition: ToolDefinition, args: object) {
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {}; // Render synchronously; never take over the test terminal.
  return new ToolExecutionComponent(
    definition.name,
    "render-test",
    args,
    { showImages: false },
    definition,
    tui,
    process.cwd(),
  );
}
const plain = (row: ToolExecutionComponent, width = 100) =>
  stripTerminalSequences(row.render(width).join("\n"));
const result = (details: object, text = "完整结果正文") => ({
  content: [{ type: "text", text }],
  details,
  isError: false,
});

test("native tool cards show effective filters, exact supplied parameters and expandable cursors for all three tools", async (t) => {
  initTheme("dark", false);
  const f = await sdkFixture(t, () => assistant());
  const definitions = f.loaded.extensions[0]?.tools;
  assert.ok(definitions);
  for (const [name, args, keys] of [
    [
      "find_run",
      {
        query: "编号 并发",
        scope: "content",
        cwd: "/tmp/archive",
        limit: 3,
        since: "2026-09-15T00:00:00Z",
        until: "2026-09-16T00:00:00Z",
        cursor: "opaque-signed-cursor",
      },
      ["query=", "scope=", "cwd=", "limit=", "since=", "until=", "cursor=续页"],
    ],
    [
      "get_message_detail",
      { id: "m1558", format: "raw" },
      ['id="m1558"', 'format="raw"'],
    ],
    [
      "delete_run",
      { ids: ["r41", "r42"], reason: "清理自建测试记录" },
      ["ids=", "r41", "r42", "reason=", "清理自建测试记录"],
    ],
  ] as const) {
    const definition = definitions.get(name)?.definition;
    assert.ok(definition);
    const row = card(definition, args);
    assert.match(plain(row), /参数接收中/);
    row.setArgsComplete();
    row.markExecutionStarted();
    assert.match(plain(row), /执行中/);
    row.updateResult(result({}));
    const text = plain(row);
    for (const key of keys) assert.ok(text.includes(key), text);
    assert.doesNotMatch(text, /opaque-signed-cursor|执行中/);
    row.setExpanded(true);
    if (name === "find_run") assert.match(plain(row), /opaque-signed-cursor/);
    for (const width of [12, 24, 40, 100])
      assert.ok(row.render(width).every((line) => visibleWidth(line) <= width));
  }
  const find = definitions.get("find_run")?.definition;
  assert.ok(find);
  const listing = card(find, {});
  listing.setArgsComplete();
  listing.updateResult(result({}));
  assert.match(plain(listing), /近期归档/);
  assert.match(plain(listing), /scope="all"/);
  assert.match(plain(listing), /全库/);
  assert.match(plain(listing), /limit=20/);
  // Session restore provides a final result without replaying setArgsComplete().
  const restored = card(find, {});
  restored.updateResult(result({}));
  assert.doesNotMatch(plain(restored), /参数接收中|执行中/);
  assert.match(plain(restored), /scope="all"/);
  assert.match(plain(restored), /limit=20/);
  const invalid = card(find, { cwd: null, scope: 123 });
  invalid.setArgsComplete();
  assert.match(plain(invalid), /cwd=null/);
  assert.match(plain(invalid), /scope=123/);
  f.checkErrors();
});

test("find cards keep candidates compact, distinguish continuation from no matches, and preserve raw expanded output", async (t) => {
  initTheme("dark", false);
  const f = await sdkFixture(t, () => assistant());
  const definition = f.loaded.extensions[0]?.tools.get("find_run")?.definition;
  assert.ok(definition);
  const row = card(definition, { query: "编号" });
  row.setArgsComplete();
  const choices = Array.from({ length: 20 }, (_, n) => ({
    id: `r${n + 1}`,
    label: `并发编号核对 ${n + 1}`,
  }));
  const details = findDetails({
    choices,
    text: "",
    displayText: "",
    next: { cursor: "next" },
  });
  assert.equal(details.page.choices.length, 3);
  const raw =
    'Run 归档\n完整的检索结果\nfind_run({"id":"r20"})\n继续：find_run({"cursor":"next"})';
  row.updateResult(result(details, raw));
  const collapsed = plain(row);
  assert.match(collapsed, /本页 20 条 Run/);
  assert.match(collapsed, /另 17 条/);
  assert.match(collapsed, /还有后续页/);
  assert.doesNotMatch(collapsed, /find_run\(|完整的检索结果/);
  row.setExpanded(true);
  for (const line of raw.split("\n")) assert.ok(plain(row).includes(line));
  const dark = row.render(100).join("\n");
  initTheme("light", false);
  row.invalidate();
  assert.notEqual(row.render(100).join("\n"), dark);
  row.setExpanded(false);
  row.updateResult(result({ page: { count: 0, choices: [], more: true } }));
  assert.match(plain(row), /本页未命中，仍有历史未搜索/);
  assert.doesNotMatch(plain(row), /没有匹配/);
  row.updateResult(result({ page: { count: 0, choices: [], more: false } }));
  assert.match(plain(row), /没有匹配的 Run/);
  row.updateArgs({ id: "r1" });
  assert.match(plain(row), /尚无已保存的消息/);
  row.updateResult({ ...result({}, "Unknown Run: bad-id"), isError: true });
  assert.match(plain(row), /Unknown Run: bad-id/);
  assert.doesNotMatch(plain(row), /本页 20|没有匹配/);
  f.checkErrors();
});

test("malformed or legacy rendering metadata falls back safely, terminal controls stay inert and narrow rows stay bounded", async (t) => {
  initTheme("dark", false);
  const f = await sdkFixture(t, () => assistant());
  const definition = f.loaded.extensions[0]?.tools.get("find_run")?.definition;
  assert.ok(definition);
  const row = card(definition, {
    query: "\x1b]52;c;clipboard\x07\u009b2J 中文🧪",
    cwd: "/very-long-path/".repeat(30),
  });
  row.setArgsComplete();
  const text = `\x1b]52;c;clipboard\x07${"原始结果\n".repeat(100)}末尾证据`;
  for (const details of [
    {},
    { page: null },
    { page: { count: -1 } },
    {
      page: { count: 0, more: false, choices: [{ id: "r1", label: "wrong" }] },
    },
  ]) {
    row.updateResult(result(details, text));
    for (const width of [12, 24, 40, 100]) {
      const rendered = row.render(width);
      assert.ok(rendered.every((line) => visibleWidth(line) <= width));
      assert.ok(!rendered.join("\n").includes("\x1b]52"));
      assert.ok(!rendered.join("\n").includes("\u009b"));
    }
    assert.doesNotMatch(plain(row), /末尾证据|wrong/);
    row.setExpanded(true);
    assert.match(plain(row), /末尾证据/);
    row.setExpanded(false);
  }
  f.checkErrors();
});

test("real SDK keeps find_run model text unchanged while adding only a bounded UI navigation snapshot", async (t) => {
  const f = await sdkFixture(t, (n) =>
    n === 2
      ? toolCall("find_run", { query: "编号", scope: "content", limit: 5 })
      : assistant("stop", "编号按数据库分配。"),
  );
  await f.session.prompt("核对编号");
  const expected = await f.archive.find({
    query: "编号",
    scope: "content",
    limit: 5,
  });
  await f.session.prompt("查找归档");
  const tool = f.session.messages.find(
    (m) => m.role === "toolResult" && m.toolName === "find_run",
  );
  assert.ok(tool && tool.role === "toolResult");
  assert.equal(tool.isError, false);
  assert.deepEqual(tool.content, [{ type: "text", text: expected.text }]);
  assert.deepEqual(tool.details, findDetails(expected));
  assert.ok(Buffer.byteLength(JSON.stringify(tool.details)) < 1024);
  f.checkErrors();
});
