import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseQuery,
  queryHitIndex,
  queryMatches,
  querySql,
} from "../src/query.ts";

test("parseQuery keeps whitespace AND, splits on OR, and treats quotes as phrases", () => {
  assert.deepEqual(parseQuery(""), { clauses: [] });
  assert.deepEqual(parseQuery("  \n"), { clauses: [] });
  assert.deepEqual(parseQuery("归档 索引"), { clauses: [["归档", "索引"]] });
  assert.deepEqual(parseQuery("不同意 OR 不认可"), {
    clauses: [["不同意"], ["不认可"]],
  });
  assert.deepEqual(parseQuery('"我的想法是"'), { clauses: [["我的想法是"]] });
  assert.deepEqual(parseQuery('"Touch ID" OR 指纹'), {
    clauses: [["touch id"], ["指纹"]],
  });
  assert.deepEqual(parseQuery('心跳 消息箱 OR "完全不认可"'), {
    clauses: [["心跳", "消息箱"], ["完全不认可"]],
  });
  assert.deepEqual(parseQuery('"OR"'), { clauses: [["or"]] });
  assert.deepEqual(parseQuery("foo or bar"), {
    clauses: [["foo", "or", "bar"]],
  });
});

test("parseQuery rejects empty OR sides, unclosed quotes and stuck tokens", () => {
  for (const query of [
    "OR foo",
    "foo OR",
    "foo OR OR bar",
    '"unterminated',
    '""',
    '"foo"bar',
    'foo"bar"',
  ])
    assert.throws(() => parseQuery(query), /OR|quote|phrase/i, query);
});

test("queryMatches is clause OR of term AND; phrases are contiguous", () => {
  const or = parseQuery("不认可 OR 落盘");
  assert.equal(queryMatches("完全不认可。", or), true);
  assert.equal(queryMatches("先确认再落盘", or), true);
  assert.equal(queryMatches("无关", or), false);
  const and = parseQuery("不认可 落盘");
  assert.equal(queryMatches("不认可再落盘", and), true);
  assert.equal(queryMatches("完全不认可。", and), false);
  const phrase = parseQuery('"我的想法是"');
  assert.equal(queryMatches("完全不认可。我的想法是这样", phrase), true);
  assert.equal(queryMatches("我的 想法是", phrase), false);
  assert.equal(queryHitIndex("xx我的想法是yy", phrase), 2);
});

test("querySql binds OR of AND groups", () => {
  const expr = "hay";
  assert.equal(querySql(expr, parseQuery("")), undefined);
  assert.deepEqual(querySql(expr, parseQuery("归档 索引")), {
    sql: "(instr(hay,?)>0 AND instr(hay,?)>0)",
    values: ["归档", "索引"],
  });
  assert.deepEqual(querySql(expr, parseQuery("不同意 OR 不认可")), {
    sql: "(instr(hay,?)>0 OR instr(hay,?)>0)",
    values: ["不同意", "不认可"],
  });
  assert.deepEqual(querySql(expr, parseQuery('心跳 消息箱 OR "完全不认可"')), {
    sql: "((instr(hay,?)>0 AND instr(hay,?)>0) OR instr(hay,?)>0)",
    values: ["心跳", "消息箱", "完全不认可"],
  });
});
