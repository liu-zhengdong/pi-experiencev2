import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Archive, DetailArgs, FindArgs, Page } from "./archive.ts";
import type { Summaries } from "./summary.ts";

// Intent: a quiet archive reader. Recent records first, native Pi typography and keys;
// the reading pane holds the text, the footer only navigation. No dashboard/maintenance debt.
export class RunPanel {
  private readonly text: Text;
  private scroll = 0;
  private pageSize = 1;
  private total = 0;
  readonly title: string;
  readonly actions: string;
  readonly height: () => number;
  readonly done: (key: string) => void;
  readonly repaint: () => void;
  readonly theme: Pick<Theme, "fg" | "bold">;
  constructor(
    title: string,
    body: string,
    actions: string,
    height: () => number,
    done: (key: string) => void,
    repaint: () => void,
    theme: Pick<Theme, "fg" | "bold">,
  ) {
    this.title = title;
    this.actions = actions;
    this.height = height;
    this.done = done;
    this.repaint = repaint;
    this.theme = theme;
    this.text = new Text(stripTerminalSequences(body), 0, 0);
  }
  invalidate(): void {
    this.text.invalidate();
  }
  render(width: number): string[] {
    const w = Math.max(1, width),
      h = Math.max(3, this.height());
    const narrow = w < 24 || h < 9;
    const inner = Math.max(1, w - (narrow ? 0 : 4));
    const content = this.text.render(inner);
    this.total = content.length;
    this.pageSize = Math.max(1, h - (narrow ? 2 : 6));
    this.scroll = Math.max(
      0,
      Math.min(this.scroll, this.total - this.pageSize),
    );
    const title = stripTerminalSequences(this.title);
    const footer = `Esc 返回  ↑↓ 滚动  ${this.actions}`;
    const lines = content.slice(this.scroll, this.scroll + this.pageSize);
    if (narrow)
      return [title, ...lines, footer].map((s) => truncateToWidth(s, w));
    const frame = (s: string) => {
      const line = truncateToWidth(s, inner);
      return `${this.theme.fg("borderMuted", "│")} ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} ${this.theme.fg("borderMuted", "│")}`;
    };
    return [
      this.theme.fg("borderMuted", `╭${"─".repeat(w - 2)}╮`),
      frame(this.theme.fg("accent", this.theme.bold(title))),
      frame(""),
      ...lines.map(frame),
      frame(
        this.theme.fg(
          "dim",
          `${this.scroll + 1}–${Math.min(this.total, this.scroll + this.pageSize)} / ${this.total}`,
        ),
      ),
      frame(this.theme.fg("muted", footer)),
      this.theme.fg("borderMuted", `╰${"─".repeat(w - 2)}╯`),
    ];
  }
  handleInput(data: string): void {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      data === "q"
    ) {
      this.done("back");
      return;
    }
    if (["n", "o", "s", "a", "r", "f"].includes(data.toLowerCase())) {
      this.done(data.toLowerCase());
      return;
    }
    if (matchesKey(data, "up")) this.scroll--;
    else if (matchesKey(data, "down")) this.scroll++;
    else if (matchesKey(data, "pageUp")) this.scroll -= this.pageSize;
    else if (matchesKey(data, "pageDown")) this.scroll += this.pageSize;
    else if (matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "end")) this.scroll = this.total;
    else return;
    this.scroll = Math.max(
      0,
      Math.min(this.scroll, this.total - this.pageSize),
    );
    this.repaint();
  }
}

async function panel(
  ctx: ExtensionContext,
  title: string,
  body: string,
  actions = "",
): Promise<string> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`${title}\n${body}`, "info");
    return "back";
  }
  return ctx.ui.custom<string>(
    (tui, theme, _keys, done) =>
      new RunPanel(
        title,
        body,
        actions,
        () => Math.max(3, Math.min(28, tui.terminal.rows - 2)),
        done,
        () => tui.requestRender(),
        theme,
      ),
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "90%", margin: 1 },
    },
  );
}

type View =
  | { kind: "find"; args: FindArgs }
  | { kind: "detail"; args: DetailArgs };
async function browse(
  archive: Archive,
  ctx: ExtensionContext,
  initial: View,
): Promise<void> {
  const stack: View[] = [initial];
  while (stack.length) {
    const view = stack.at(-1);
    if (!view) break;
    let page: Page<FindArgs> | Page<DetailArgs>;
    const listing = stack.findLast((v) => v.kind === "find" && !v.args.id);
    const searchCwd = listing?.kind === "find" ? listing.args.cwd : ctx.cwd;
    try {
      ctx.ui.setStatus("runs-query", "读取归档…");
      page =
        view.kind === "find"
          ? await archive.find(view.args, ctx.signal)
          : archive.detail(view.args);
    } catch (error) {
      ctx.ui.setStatus("runs-query", undefined);
      const action = await panel(
        ctx,
        "归档读取失败",
        String(error),
        view.kind === "detail" ? "F 原始 JSON" : "",
      );
      if (action === "f" && view.kind === "detail")
        stack[stack.length - 1] = {
          kind: "detail",
          args: { id: view.args.id, format: "raw" },
        };
      else stack.pop();
      continue;
    } finally {
      ctx.ui.setStatus("runs-query", undefined);
    }
    const title =
      view.kind === "detail"
        ? `${view.args.id} · ${view.args.format === "raw" ? "原始 JSON" : "消息详情"}`
        : view.args.id
          ? `${view.args.id} · 执行过程`
          : `Run 归档 · ${view.args.cwd === undefined ? "全库" : "当前目录"}`;
    const action = await panel(
      ctx,
      title,
      page.displayText,
      `${page.choices.length ? "O 打开  " : ""}${page.next ? "N 下一页  " : ""}${view.kind === "detail" ? "F 文本/JSON  " : ""}S 搜索  ${searchCwd === undefined ? "" : "A 全库  "}R 刷新`,
    );
    if (action === "back") stack.pop();
    else if (action === "n" && page.next)
      stack.push({ kind: view.kind, args: page.next } as View);
    else if (action === "o" && page.choices.length) {
      const labels = page.choices.map((c) =>
        stripTerminalSequences(`${c.id} · ${c.label}`).replace(/\s+/gu, " "),
      );
      const chosen = await ctx.ui.select("打开记录", labels);
      const item =
        chosen === undefined ? undefined : page.choices[labels.indexOf(chosen)];
      if (item)
        stack.push(
          item.id.startsWith("r")
            ? { kind: "find", args: { id: item.id } }
            : { kind: "detail", args: { id: item.id } },
        );
    } else if (action === "s") {
      const query = await ctx.ui.input(
        "搜索归档",
        '关键词（空白 AND，OR，"短语"）',
      );
      if (query !== undefined)
        stack.push({
          kind: "find",
          args: {
            query,
            ...(searchCwd === undefined ? {} : { cwd: searchCwd }),
          },
        });
    } else if (action === "a" && searchCwd !== undefined)
      stack.push({
        kind: "find",
        args:
          listing?.kind === "find" ? { query: listing.args.query ?? "" } : {},
      });
    else if (action === "f" && view.kind === "detail")
      stack.push({
        kind: "detail",
        args: {
          id: view.args.id,
          format: view.args.format === "raw" ? "text" : "raw",
        },
      });
    else if (action === "r") {
      const { cursor: _cursor, ...args } = view.args;
      stack[stack.length - 1] = { kind: view.kind, args } as View;
    }
  }
}

export function registerCommands(
  pi: ExtensionAPI,
  state: () => { archive: Archive; summaries?: Summaries; failure?: string },
): void {
  pi.registerCommand("runs", {
    description:
      "浏览 Run 归档；search <关键词> / all / rID / rID/mID / summary rID / debug",
    async handler(args, ctx) {
      try {
        const s = state(),
          input = args.trim();
        if (input === "debug") {
          await panel(
            ctx,
            "Run 归档诊断",
            JSON.stringify(
              {
                database: s.archive.store.path,
                recordingError: s.failure ?? null,
                summaryError: s.summaries?.lastError ?? null,
                runs: s.archive.store.db
                  .prepare("SELECT count(*) AS n FROM runs")
                  .get()?.n,
                summaryEnabled: !!s.summaries,
              },
              null,
              2,
            ),
          );
          return;
        }
        if (input.startsWith("summary ")) {
          if (!s.summaries)
            throw new Error("自动摘要已关闭；移除 --runs-no-summary 后重试。");
          const ref = input.slice(8).trim();
          s.summaries.enqueue(ref, ctx);
          ctx.ui.notify(
            "摘要请求已处理；已有摘要会保留，缺失摘要在后台生成。",
            "info",
          );
          return;
        }
        const messageRef = /^((?:r[1-9]\d*\/)?m[1-9]\d*)(?: (raw))?$/.exec(
          input,
        );
        const view: View = messageRef
          ? {
              kind: "detail",
              args: {
                id: messageRef[1] ?? "",
                ...(messageRef[2] ? { format: "raw" } : {}),
              },
            }
          : /^r[1-9]\d*$/.test(input)
            ? { kind: "find", args: { id: input } }
            : {
                kind: "find",
                args:
                  input === "all"
                    ? {}
                    : {
                        cwd: ctx.cwd,
                        query: input.startsWith("search ")
                          ? input.slice(7)
                          : input,
                      },
              };
        await browse(s.archive, ctx, view);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
