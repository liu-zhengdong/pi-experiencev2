import { createHash, createHmac, randomBytes } from "node:crypto";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import {
  messagePreview,
  messageText,
  object,
  preview,
  textBodies,
} from "./content.ts";
import { integer, runFromRow, text } from "./data.ts";
import type { RunStore } from "./store.ts";

export type FindArgs = {
  query?: string;
  scope?: "all" | "summary" | "content";
  cwd?: string;
  since?: string;
  until?: string;
  id?: string;
  limit?: number;
  cursor?: string;
};
export type DetailArgs = {
  id: string;
  format?: "text" | "raw";
  cursor?: string;
};
export type Run = ReturnType<typeof runFromRow> & { cwd: string };
export type Page<T> = {
  text: string;
  displayText: string;
  next?: T;
  choices: { id: string; label: string }[];
};
const SELECT =
  "SELECT r.*, s.cwd FROM runs r JOIN sessions s ON s.id=r.session_id";
const OUTPUT_BYTES = 12_000;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function date(value: string): string {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error(
      "Use an ISO timestamp with timezone, e.g. 2026-09-15T00:00:00Z",
    );
  if (
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
    value.slice(0, 10)
  )
    throw new Error("Invalid calendar date");
  return new Date(value).toISOString();
}
function run(row: Parameters<typeof runFromRow>[0]): Run {
  return { ...runFromRow(row), cwd: text(row, "cwd") };
}
function header(r: Run): string {
  return `r${r.ordinal}\n${r.startedAt}${r.endedAt ? ` → ${r.endedAt}` : ""}\n${r.cwd}\n${r.overview ?? `摘要未生成 · ${preview(r.goal || "无用户文本", 200)}`}`;
}

function displayHeading(r: Run): string {
  return `r${r.ordinal} · ${r.startedAt.slice(0, 19).replace("T", " ")} UTC`;
}

type ArchivedMessage = { role: string; [key: string]: unknown };
function parseMessage(payload: string, ref: string): ArchivedMessage {
  try {
    const message = object(JSON.parse(payload));
    if (typeof message.role !== "string")
      throw new Error("Missing message role");
    return message as ArchivedMessage;
  } catch (cause) {
    // Normally guaranteed by SQLite's json_valid constraint. Keep corruption
    // explicit rather than hiding an unreadable record as an empty search hit.
    throw new Error(
      `Invalid archived message ${ref}; raw mode can read the stored bytes`,
      { cause },
    );
  }
}

/** Archive queries have no reference to Pi's live context or compaction state. */
export class Archive {
  readonly store: RunStore;
  private readonly key = randomBytes(32);
  private projection: { id: string; body: string } | undefined;
  constructor(store: RunStore) {
    this.store = store;
  }

  private token(data: unknown): string {
    const body = Buffer.from(JSON.stringify(data)).toString("base64url");
    return `${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
  }
  private cursor(
    value: string | undefined,
    query: unknown,
  ): { at: number; ceiling: number } | undefined {
    if (!value) return;
    if (value.length > 1024)
      throw new Error("Invalid cursor; restart the query");
    try {
      const [body, signature, extra] = value.split(".");
      if (
        !body ||
        extra ||
        signature !==
          createHmac("sha256", this.key).update(body).digest("base64url")
      )
        throw new Error();
      const data = JSON.parse(Buffer.from(body, "base64url").toString());
      if (
        data.query !== digest(query) ||
        !Number.isSafeInteger(data.at) ||
        data.at < 0 ||
        !Number.isSafeInteger(data.ceiling) ||
        data.ceiling < 0
      )
        throw new Error();
      return data;
    } catch {
      throw new Error(
        "Invalid, changed-query or expired cursor; restart the query",
      );
    }
  }
  private continuation(query: unknown, at: number, ceiling: number): string {
    return this.token({ query: digest(query), at, ceiling });
  }

  getRun(ref: string): Run {
    const column = /^r[1-9]\d*$/.test(ref) ? "ordinal" : "id";
    const id = column === "ordinal" ? Number(ref.slice(1)) : ref;
    const row = this.store.db.prepare(`${SELECT} WHERE r.${column}=?`).get(id);
    if (row) return run(row);
    if (
      this.store.db
        .prepare(`SELECT 1 FROM deleted_runs WHERE ${column}=?`)
        .get(id)
    )
      throw new Error(`Run ${ref} 已被删除`);
    throw new Error(`Unknown Run: ${ref}`);
  }

  async find(
    args: FindArgs = {},
    signal?: AbortSignal,
  ): Promise<Page<FindArgs>> {
    signal?.throwIfAborted();
    const limit = args.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new Error("limit must be 1–50");
    if (args.id) {
      if (
        args.query !== undefined ||
        args.scope !== undefined ||
        args.cwd !== undefined ||
        args.since !== undefined ||
        args.until !== undefined
      )
        throw new Error(
          "Use id alone (with optional limit/cursor), not search filters",
        );
      return this.runPage(args, limit);
    }
    const query = args.query ?? "";
    if (Array.from(query).length > 256)
      throw new Error("query must be at most 256 Unicode characters");
    const scope = args.scope ?? "all";
    if (scope !== "all" && scope !== "summary" && scope !== "content")
      throw new Error("scope must be all, summary or content");
    const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
    if (scope === "content" && !terms.length)
      throw new Error("Content search needs nonempty keywords");
    const since = args.since === undefined ? undefined : date(args.since);
    const until = args.until === undefined ? undefined : date(args.until);
    if (since && until && since >= until)
      throw new Error("since must precede until");
    const bound = { query, scope, cwd: args.cwd ?? null, since, until, limit };
    const cursor = this.cursor(args.cursor, bound);
    const ceiling =
      cursor?.ceiling ??
      Number(
        this.store.db
          .prepare("SELECT coalesce(max(ordinal),0) AS n FROM runs")
          .get()?.n,
      );
    let at = cursor?.at ?? ceiling + 1;
    const where = ["r.ordinal <= ?", "r.ordinal < ?", "r.status != 'running'"];
    const values: SQLInputValue[] = [ceiling, at];
    if (args.cwd !== undefined) {
      where.push("s.cwd=?");
      values.push(args.cwd);
    }
    if (since) {
      where.push("r.started_at>=?");
      values.push(since);
    }
    if (until) {
      where.push("r.started_at<?");
      values.push(until);
    }
    if (scope === "summary") {
      for (const term of terms) {
        where.push(
          "instr(lower(coalesce(r.overview,'') || char(10) || r.goal || char(10) || s.cwd || char(10) || r.agent_id),?)>0",
        );
        values.push(term);
      }
    }
    // Bound a content scan. A continuation means 'not searched yet', never 'no matches'.
    const rows = this.store.db
      .prepare(
        `${SELECT} WHERE ${where.join(" AND ")} ORDER BY r.ordinal DESC LIMIT ${scope === "summary" || !terms.length ? limit + 1 : 251}`,
      )
      .all(...values);
    const choices: Page<FindArgs>["choices"] = [];
    const parts: string[] = [],
      displayParts: string[] = [];
    let bytes = 0,
      visited = 0;
    const start = performance.now();
    for (const row of rows.slice(0, 250)) {
      signal?.throwIfAborted();
      const r = run(row);
      let match = "";
      const summaryHit =
        scope !== "content" &&
        terms.every((term) =>
          `${r.overview ?? ""}\n${r.goal}\n${r.cwd}\n${r.agentId}`
            .toLowerCase()
            .includes(term),
        );
      if (!summaryHit && scope !== "summary") {
        const messages = this.store.db
          .prepare(
            "SELECT first_seq,payload FROM messages WHERE run_id=? ORDER BY first_seq",
          )
          .iterate(r.id);
        let position = 0;
        for (const message of messages) {
          position++;
          const ref = `r${r.ordinal}/m${position}`;
          const body = textBodies(
            parseMessage(text(message, "payload"), ref),
          ).find((body) => {
            const lower = body.toLowerCase();
            return terms.every((term) => lower.includes(term));
          });
          if (body !== undefined) {
            const index = body.toLowerCase().indexOf(terms[0] ?? "");
            match = `\n命中 ${ref} · ${preview(body.slice(Math.max(0, index - 80)).replaceAll("\n", " "), 240)}\nget_message_detail({"id":"${ref}"})`;
            break;
          }
        }
      }
      const line = `${header(r)}${match}\nfind_run({"id":"r${r.ordinal}"})`;
      const include = summaryHit || !!match;
      if (
        include &&
        choices.length &&
        bytes + Buffer.byteLength(line) > OUTPUT_BYTES
      )
        break;
      at = r.ordinal;
      visited++;
      if (include) {
        parts.push(line);
        displayParts.push(
          [
            displayHeading(r),
            r.overview ??
              `摘要未生成 · ${preview(r.goal || "无用户文本", 200)}`,
            args.cwd === undefined ? r.cwd : "",
            match ? match.slice(0, match.lastIndexOf("\n")) : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        bytes += Buffer.byteLength(line);
        choices.push({
          id: `r${r.ordinal}`,
          label: preview(r.overview ?? r.goal, 80),
        });
      }
      if (choices.length >= limit || performance.now() - start > 1500) break;
      if (scope !== "summary")
        await setImmediate(undefined, signal ? { signal } : {});
    }
    const more = visited < rows.length;
    const next = more
      ? { ...args, cursor: this.continuation(bound, at, ceiling) }
      : undefined;
    const textResult = [
      "Run 归档 · 历史证据，不代表当前状态",
      ...parts,
      parts.length
        ? ""
        : more
          ? "本页未命中，尚有历史未搜索。"
          : "没有匹配的 Run。",
      next ? `继续：find_run(${JSON.stringify(next)})` : "[已读完]",
    ]
      .filter(Boolean)
      .join("\n\n");
    const displayText = displayParts.length
      ? displayParts.join("\n\n")
      : more
        ? "本页未命中。N 继续搜索剩余历史。"
        : terms.length
          ? `没有匹配的 Run。S 换关键词${args.cwd === undefined ? "。" : "，或 A 扩大到全库。"}`
          : `当前范围还没有 Run。开始对话后会自动记录${args.cwd === undefined ? "。" : "；A 查看全库。"}`;
    return {
      text: textResult,
      displayText: terms.length
        ? `关键词：${query}\n\n${displayText}`
        : displayText,
      ...(next ? { next } : {}),
      choices,
    };
  }

  private runPage(args: FindArgs, limit: number): Page<FindArgs> {
    const r = this.getRun(args.id ?? "");
    const query = { id: r.id, limit };
    const cursor = this.cursor(args.cursor, query);
    const ceiling =
      cursor?.ceiling ??
      Number(
        this.store.db
          .prepare(
            "SELECT coalesce(max(first_seq),0) AS n FROM messages WHERE run_id=?",
          )
          .get(r.id)?.n,
      );
    const rows = this.store.db
      .prepare(
        "SELECT id, first_seq, role, payload FROM messages WHERE run_id=? AND first_seq>? AND first_seq<=? ORDER BY first_seq LIMIT ?",
      )
      .all(r.id, cursor?.at ?? 0, ceiling, limit + 1);
    const startPosition = Number(
      this.store.db
        .prepare(
          "SELECT count(*) AS n FROM messages WHERE run_id=? AND first_seq<=?",
        )
        .get(r.id, cursor?.at ?? 0)?.n,
    );
    const parts: string[] = [],
      displayParts: string[] = [];
    const choices: Page<FindArgs>["choices"] = [];
    let bytes = 0,
      at = cursor?.at ?? 0,
      position = startPosition;
    for (const row of rows.slice(0, limit)) {
      position++;
      const ref = `r${r.ordinal}/m${position}`;
      const snippet = preview(
        messagePreview(parseMessage(text(row, "payload"), ref)),
        1600,
      );
      const display = `[${ref}] ${text(row, "role")}\n${snippet}`;
      const body = `${display}\nget_message_detail({"id":"${ref}"})`;
      if (parts.length && bytes + Buffer.byteLength(body) > OUTPUT_BYTES) break;
      parts.push(body);
      displayParts.push(display);
      bytes += Buffer.byteLength(body);
      at = integer(row, "first_seq");
      choices.push({
        id: ref,
        label: `${text(row, "role")} ${preview(snippet, 60)}`,
      });
    }
    const more = choices.length < rows.length;
    const next = more
      ? { ...args, cursor: this.continuation(query, at, ceiling) }
      : undefined;
    return {
      choices,
      ...(next ? { next } : {}),
      displayText: [
        displayHeading(r),
        r.overview ?? "摘要未生成",
        "消息预览 · O 读取完整详情",
        ...displayParts,
      ].join("\n\n"),
      text: [
        header(r),
        "执行过程 · 预览，完整内容按消息 ID 展开",
        ...parts,
        parts.length ? "" : "尚无已落库消息。",
        next ? `继续：find_run(${JSON.stringify(next)})` : "[已读完]",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  detail(args: DetailArgs): Page<DetailArgs> {
    const format = args.format ?? "text";
    if (format !== "text" && format !== "raw")
      throw new Error("format must be text or raw");
    const composite = /^r([1-9]\d*)\/m([1-9]\d*)$/.exec(args.id);
    let row: Record<string, SQLOutputValue> | undefined;
    if (composite) {
      // Run-scoped refs are derived from first_seq order; no stored ordinal.
      const runRow = this.store.db
        .prepare("SELECT id FROM runs WHERE ordinal=?")
        .get(Number(composite[1]));
      row = runRow
        ? this.store.db
            .prepare(
              "SELECT id,role FROM messages WHERE run_id=? ORDER BY first_seq LIMIT 1 OFFSET ?",
            )
            .get(text(runRow, "id"), Number(composite[2]) - 1)
        : undefined;
    } else {
      // Legacy global m-numbers and message UUIDs keep old citations readable.
      const numeric = /^m[1-9]\d*$/.test(args.id);
      row = this.store.db
        .prepare(
          `SELECT id,role FROM messages WHERE ${numeric ? "first_seq" : "id"}=?`,
        )
        .get(numeric ? Number(args.id.slice(1)) : args.id);
    }
    if (!row)
      throw new Error(`Message not found (or its Run was deleted): ${args.id}`);
    // Terminal messages are immutable. Validate existence even when the text projection is cached.
    const messageId = text(row, "id");
    const query = { id: messageId, format };
    const cursor = this.cursor(args.cursor, query);
    const at = cursor?.at ?? 0;
    let part: string, end: number, length: number;
    if (format === "raw") {
      // Byte ranges avoid re-parsing, hashing and transferring the entire JSON on every page.
      const chunk = this.store.db
        .prepare(
          "SELECT substr(CAST(payload AS BLOB),?,?) AS chunk, length(CAST(payload AS BLOB)) AS size FROM messages WHERE id=?",
        )
        .get(at + 1, OUTPUT_BYTES + 4, row.id ?? null);
      const bytes = chunk?.chunk;
      if (!(bytes instanceof Uint8Array))
        throw new Error("Cannot read message bytes");
      length = Number(chunk?.size);
      let take = Math.min(OUTPUT_BYTES, bytes.length);
      while (
        take > 0 &&
        take < bytes.length &&
        ((bytes[take] ?? 0) & 0xc0) === 0x80
      )
        take--;
      part = Buffer.from(bytes.subarray(0, take)).toString("utf8");
      end = at + take;
    } else {
      if (this.projection?.id !== messageId) {
        const payload = this.store.db
          .prepare("SELECT payload FROM messages WHERE id=?")
          .get(row.id ?? null);
        const body = messageText(
          parseMessage(text(payload ?? {}, "payload"), args.id),
        );
        if (Buffer.byteLength(body) > 8 * 1024 * 1024)
          throw new Error(
            `Text projection exceeds 8 MiB; use get_message_detail(${JSON.stringify({ id: args.id, format: "raw" })})`,
          );
        this.projection = { id: text(row, "id"), body };
      }
      const body = this.projection.body;
      length = body.length;
      end = Math.min(length, at + OUTPUT_BYTES);
      while (Buffer.byteLength(body.slice(at, end)) > OUTPUT_BYTES)
        end = at + Math.floor((end - at) * 0.8);
      if (end < length && /[\uD800-\uDBFF]/u.test(body[end - 1] ?? "")) end--;
      part = body.slice(at, end);
    }
    if (at > length) throw new Error("Invalid message cursor");
    const next =
      end < length
        ? { ...args, cursor: this.continuation(query, end, length) }
        : undefined;
    return {
      choices: [],
      displayText: part,
      ...(next ? { next } : {}),
      text: `${args.id} · ${text(row, "role")} · ${format}\n正文位于分隔线之间，按顺序拼接各页即可还原。\n---\n${part}\n---\n${next ? `继续：get_message_detail(${JSON.stringify(next)})` : "[已读完]"}`,
    };
  }

  deleteRuns(
    ids: string[],
    reason: string,
  ): { deleted: string[]; alreadyDeleted: string[] } {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 200 ||
      ids.some((id) => typeof id !== "string" || !id || id.length > 128) ||
      typeof reason !== "string" ||
      !reason.trim() ||
      Array.from(reason).length > 500
    )
      throw new Error(
        "Use 1–200 Run IDs and a nonempty reason of at most 500 characters",
      );
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const targets = new Map<string, Run>();
      const alreadyDeleted: string[] = [];
      for (const id of new Set(ids)) {
        const column = /^r[1-9]\d*$/.test(id) ? "ordinal" : "id";
        if (
          db
            .prepare(`SELECT 1 FROM deleted_runs WHERE ${column}=?`)
            .get(column === "ordinal" ? Number(id.slice(1)) : id)
        ) {
          alreadyDeleted.push(id);
          continue;
        }
        const r = this.getRun(id);
        if (r.recording) throw new Error(`Active Run cannot be deleted: ${id}`);
        targets.set(r.id, r);
      }
      const messageDelete = db.prepare("DELETE FROM messages WHERE run_id=?");
      const eventDelete = db.prepare("DELETE FROM events WHERE run_id=?");
      const runDelete = db.prepare("DELETE FROM runs WHERE id=?");
      const tombstone = db.prepare("INSERT INTO deleted_runs VALUES (?,?,?,?)");
      for (const r of targets.values()) {
        messageDelete.run(r.id);
        eventDelete.run(r.id);
        runDelete.run(r.id);
        tombstone.run(r.ordinal, r.id, new Date().toISOString(), reason.trim());
      }
      db.exec("COMMIT");
      return {
        deleted: [...targets.values()].map((r) => `r${r.ordinal}`),
        alreadyDeleted,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
