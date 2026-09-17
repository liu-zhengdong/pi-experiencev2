import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "pi-experiencev2.json";

/** Global extension configuration, read from <agentDir>/pi-experiencev2.json.
 *  Every key is optional; CLI flags and environment variables take precedence. */
export type RunArchiveConfig = {
  db?: string;
  noSummary?: boolean;
  overviewLimit?: number;
};

/** Missing file yields an empty config; present but malformed content throws. */
export function loadConfig(agentDir: string): RunArchiveConfig {
  const path = join(agentDir, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`无法读取配置文件 ${path}：${String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`配置文件 ${path} 不是有效 JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`配置文件 ${path} 必须是 JSON 对象`);
  const input = value as Record<string, unknown>;
  const config: RunArchiveConfig = {};
  if (input.db !== undefined) {
    if (typeof input.db !== "string" || !input.db.trim())
      throw new Error(`配置文件 ${path}：db 必须是非空字符串`);
    config.db = input.db;
  }
  if (input.noSummary !== undefined) {
    if (typeof input.noSummary !== "boolean")
      throw new Error(`配置文件 ${path}：noSummary 必须是布尔值`);
    config.noSummary = input.noSummary;
  }
  if (input.overviewLimit !== undefined) {
    if (typeof input.overviewLimit !== "number")
      throw new Error(`配置文件 ${path}：overviewLimit 必须是数字`);
    config.overviewLimit = input.overviewLimit;
  }
  return config;
}
