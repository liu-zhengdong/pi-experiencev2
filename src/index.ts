import { join, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Archive } from "./archive.ts";
import { loadConfig } from "./config.ts";
import { type RecordedEvent, RunRecorder } from "./recorder.ts";
import { RunStore } from "./store.ts";
import { parseOverviewLimit, Summaries } from "./summary.ts";
import { registerTools } from "./tools.ts";
import { registerCommands } from "./ui.ts";

export default function runArchive(pi: ExtensionAPI): void {
  pi.registerFlag("runs-db", {
    type: "string",
    description: "Independent pi-experiencev2 SQLite path (PI_RUNS_DB)",
  });
  pi.registerFlag("runs-no-summary", {
    type: "boolean",
    description: "Record Runs without background model summaries",
  });
  pi.registerFlag("runs-overview-limit", {
    type: "string",
    description:
      "Overview character limit 1–2000 (PI_RUNS_OVERVIEW_LIMIT, default 200)",
  });
  let recorder: RunRecorder | undefined;
  let archive: Archive | undefined;
  let summaries: Summaries | undefined;
  let uiContext: ExtensionContext | undefined;
  let latestNotice = 0;
  let failure: string | undefined;
  const getArchive = () => {
    if (failure || !archive)
      throw new Error(failure ?? "Run archive has not started");
    return archive;
  };

  const capture = async (
    event: RecordedEvent,
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (event.type === "session_shutdown") {
      const worker = summaries,
        closing = recorder;
      summaries = undefined;
      recorder = undefined;
      archive = undefined;
      uiContext = undefined;
      try {
        await worker?.close(
          (ctx.mode === "print" || ctx.mode === "json") && !ctx.signal?.aborted
            ? 30_000
            : 0,
        );
        if (closing) {
          try {
            if (!failure) closing.capture(event);
          } finally {
            closing.close(`shutdown:${event.reason}`);
          }
        }
      } finally {
        ctx.ui.setWidget("runs-summary", undefined);
        ctx.ui.setStatus("runs-error", undefined);
      }
      return;
    }
    if (failure) {
      ctx.abort();
      return;
    }
    uiContext = ctx;
    try {
      if (!recorder) {
        let config: ReturnType<typeof loadConfig> = {};
        try {
          config = loadConfig(getAgentDir());
        } catch (error) {
          ctx.ui.notify(
            `pi-experiencev2 配置文件无效，已忽略：${String(error)}`,
            "error",
          );
        }
        const selected =
          pi.getFlag("runs-db") ?? process.env.PI_RUNS_DB ?? config.db;
        const path =
          typeof selected === "string" && selected.trim()
            ? resolve(ctx.cwd, selected)
            : join(getAgentDir(), "run-archive", "runs.sqlite");
        const store = new RunStore(path);
        try {
          recorder = new RunRecorder(store, "pi", {
            piSessionId: ctx.sessionManager.getSessionId(),
            cwd: ctx.cwd,
            title: ctx.sessionManager.getSessionName() ?? null,
            reason:
              event.type === "session_start" ? event.reason : "late_attach",
          });
        } catch (error) {
          store.close();
          throw error;
        }
        archive = new Archive(store);
        const noSummary =
          pi.getFlag("runs-no-summary") === true || config.noSummary === true;
        let overviewLimit: number | undefined;
        try {
          overviewLimit = parseOverviewLimit(
            pi.getFlag("runs-overview-limit") ??
              process.env.PI_RUNS_OVERVIEW_LIMIT ??
              config.overviewLimit,
          );
        } catch (error) {
          ctx.ui.notify(
            `runs-overview-limit 配置无效，本会话不生成概述：${String(error)}`,
            "error",
          );
        }
        if (!noSummary && overviewLimit !== undefined) {
          summaries = new Summaries(
            archive,
            (notice) => {
              if (
                !uiContext?.hasUI ||
                Number(notice.id.slice(1)) < latestNotice
              )
                return;
              latestNotice = Number(notice.id.slice(1));
              uiContext.ui.setWidget(
                "runs-summary",
                [
                  `本轮摘要 · ${notice.id} · ${notice.state === "saved" ? "已保存" : notice.state === "pending" ? "生成中" : "未生成"}`,
                  stripTerminalSequences(notice.text),
                ].map((line) => uiContext?.ui.theme.fg("muted", line) ?? line),
              );
            },
            { overviewLimit },
          );
        }
      }
      const settled = event.type === "agent_settled" ? recorder.runRef : null;
      recorder.capture(event);
      if (settled) summaries?.enqueue(`r${settled}`, ctx);
    } catch (error) {
      failure = String(error);
      ctx.ui.setStatus("runs-error", "Run 录制失败");
      ctx.ui.notify(
        `Run 录制失败，已请求停止；修复后重新加载：${failure}`,
        "error",
      );
      ctx.abort();
      throw error;
    }
  };

  pi.on("session_start", capture);
  pi.on("session_info_changed", capture);
  pi.on("session_shutdown", capture);
  pi.on("session_before_fork", capture);
  pi.on("session_tree", capture);
  pi.on("agent_start", capture);
  pi.on("agent_end", capture);
  pi.on("agent_settled", capture);
  pi.on("turn_start", capture);
  pi.on("turn_end", capture);
  pi.on("message_start", capture);
  pi.on("message_end", capture);
  pi.on("tool_execution_start", capture);
  pi.on("tool_execution_end", capture);
  pi.on("session_compact", capture);
  pi.on("session_compact_failed", capture);
  pi.on("input", capture);
  pi.on("user_bash", capture);
  pi.on("model_select", capture);
  pi.on("thinking_level_select", capture);
  // No context/before_agent_start/provider rewriting, compaction hooks, messages or guidance injection.
  registerTools(pi, getArchive);
  registerCommands(pi, () => {
    if (!archive) throw new Error(failure ?? "Run archive has not started");
    return {
      archive,
      ...(summaries ? { summaries } : {}),
      ...(failure ? { failure } : {}),
    };
  });
}
