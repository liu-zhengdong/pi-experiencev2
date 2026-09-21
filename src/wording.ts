import { preview } from "./content.ts";

/** The archive says the same few things from three places: the tool result, the
 *  panel, and the collapsed tool row. Each had drifted its own wording for the
 *  same state, so a user could see "尚有历史未搜索" and "仍有历史未搜索" for one
 *  result. The phrasing lives here; callers choose which state applies. */

export const NO_MATCH = "没有匹配的 Run。";
export const PAGE_MISSED = "本页未命中，尚有历史未搜索。";
export const NO_MESSAGES = "尚无已保存的消息。";

/** A Run's one-line description: its overview, or what it was asked to do. */
export function overviewLine(
  overview: string | null,
  goal: string,
  limit = 200,
): string {
  return overview ?? `摘要未生成 · ${preview(goal || "无用户文本", limit)}`;
}
