import { keyHint, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  stripTerminalSequences,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { FindArgs, Page } from "./archive.ts";
import { object, preview } from "./content.ts";
import { NO_MATCH, NO_MESSAGES, PAGE_MISSED } from "./wording.ts";

type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
type ToolName = "find_run" | "get_message_detail" | "delete_run";

/** A bounded navigation snapshot, not a second copy of the complete tool output. */
export function findDetails(page: Page<FindArgs>) {
  return {
    page: {
      count: page.choices.length,
      more: !!page.next,
      choices: page.choices.slice(0, 3),
    },
  };
}

function clean(value: string): string {
  return stripTerminalSequences(value).replace(/\p{Cc}/gu, (c) =>
    c === "\n" || c === "\t" ? c : "",
  );
}

function argument(value: unknown, expanded: boolean): string {
  try {
    const encoded = JSON.stringify(value) ?? String(value);
    return expanded ? encoded : preview(encoded, 160);
  } catch {
    return "[无法显示]";
  }
}

class ToolText extends Text {
  maxLines = Number.POSITIVE_INFINITY;
  hint = "";
  override render(width: number): string[] {
    if (width < 1) return [];
    const lines = super.render(width);
    const shown = lines.slice(0, this.maxLines);
    if (lines.length > this.maxLines && this.hint) shown.push(this.hint);
    return shown.map((line) => truncateToWidth(line, width));
  }
}

function component(
  last: Component | undefined,
  text: string,
  maxLines = Number.POSITIVE_INFINITY,
  hint = "",
): ToolText {
  const result = last instanceof ToolText ? last : new ToolText("", 0, 0);
  result.setText(text);
  result.maxLines = maxLines;
  result.hint = hint;
  return result;
}

export function renderArchiveCall(name: ToolName): CallRenderer {
  return (args, theme, context) => {
    const p = object(args);
    // Restored tool rows can have a final result without replaying argsComplete.
    const ready = context.argsComplete || !context.isPartial;
    const values = { ...p };
    if (ready && name === "find_run" && p.id === undefined) {
      if (values.scope === undefined) values.scope = "all";
      if (values.cwd === undefined) values.cwd = "（全库）";
      if (values.limit === undefined) values.limit = 20;
    }
    if (ready && name === "get_message_detail" && values.format === undefined)
      values.format = "text";
    const primary =
      name === "find_run"
        ? ["id", "query"]
        : name === "get_message_detail"
          ? ["id", "format"]
          : ["ids"];
    const field = ([key, value]: [string, unknown]) => {
      const valueText =
        key === "cursor" && !context.expanded
          ? "续页"
          : argument(value, context.expanded);
      return (
        theme.fg("muted", `${clean(key)}=`) + theme.fg("text", clean(valueText))
      );
    };
    const entries = Object.entries(values).filter(
      ([, value]) => value !== undefined,
    );
    const headline = entries
      .filter(([key]) => primary.includes(key))
      .map(field);
    const secondary = entries
      .filter(([key]) => !primary.includes(key))
      .map(field);
    let text = theme.fg("toolTitle", theme.bold(name));
    if (headline.length) text += ` ${headline.join("  ")}`;
    else if (name === "find_run" && ready)
      text += theme.fg("muted", " 近期归档");
    if (secondary.length)
      text += `\n${secondary.join(context.expanded ? "\n" : " · ")}`;
    if (!ready) text += theme.fg("dim", " · 参数接收中…");
    else if (context.isPartial) text += theme.fg("dim", " · 执行中…");
    if (
      !context.expanded &&
      entries.some(
        ([key, value]) =>
          key === "cursor" || argument(value, true).length > 160,
      )
    )
      text += `\n${theme.fg("dim", keyHint("app.tools.expand", "完整参数"))}`;
    return component(context.lastComponent, text);
  };
}

function pagePreview(
  details: unknown,
): ReturnType<typeof findDetails>["page"] | undefined {
  const p = object(object(details).page);
  if (
    typeof p.count !== "number" ||
    !Number.isSafeInteger(p.count) ||
    p.count < 0 ||
    p.count > 50 ||
    typeof p.more !== "boolean" ||
    !Array.isArray(p.choices) ||
    p.choices.length > 3 ||
    p.choices.length > p.count ||
    !p.choices.every(
      (c) =>
        typeof object(c).id === "string" && typeof object(c).label === "string",
    )
  )
    return;
  return {
    count: p.count,
    more: p.more,
    choices: p.choices as { id: string; label: string }[],
  };
}

export const renderFindResult: ResultRenderer = (
  result,
  { expanded, isPartial },
  theme,
  context,
) => {
  const raw = clean(
    result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n"),
  );
  const hint = theme.fg("dim", keyHint("app.tools.expand", "完整结果"));
  if (isPartial)
    return component(
      context.lastComponent,
      theme.fg("muted", raw || "正在查找…"),
      4,
      hint,
    );
  if (context.isError)
    return component(
      context.lastComponent,
      theme.fg("error", raw),
      expanded ? Infinity : 6,
      hint,
    );
  const page = pagePreview(result.details);
  if (expanded || !page)
    return component(
      context.lastComponent,
      theme.fg("toolOutput", raw),
      expanded ? Infinity : 6,
      hint,
    );
  const reading = !!object(context.args).id;
  const title = page.count
    ? `本页 ${page.count} 条${reading ? "消息" : " Run"}`
    : reading
      ? NO_MESSAGES
      : page.more
        ? PAGE_MISSED
        : NO_MATCH;
  const lines = [theme.fg("muted", title)];
  for (const choice of page.choices)
    lines.push(
      `${theme.fg("accent", clean(choice.id))}  ${theme.fg("toolOutput", clean(choice.label).replace(/\s+/g, " "))}`,
    );
  if (page.more) lines.push(theme.fg("muted", "还有后续页"));
  if (page.count)
    lines.push(
      (page.count > page.choices.length
        ? theme.fg("dim", `另 ${page.count - page.choices.length} 条 · `)
        : "") + hint,
    );
  return component(context.lastComponent, lines.join("\n"));
};
