export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assistantError(p: Record<string, unknown>): string {
  return p.role === "assistant" && typeof p.errorMessage === "string"
    ? p.errorMessage
    : "";
}

/** Search readable text and model errors, never encoded media or private diagnostics. */
export function textBodies(payload: unknown): string[] {
  const p = object(payload),
    content = p.content;
  const bodies =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((block: unknown) => {
            const b = object(block);
            return b.type === "text" && typeof b.text === "string"
              ? [b.text]
              : [];
          })
        : [];
  const error = assistantError(p);
  if (error) bodies.push(error);
  return bodies;
}

export function preview(text: string, maximum: number): string {
  // UTF-16 slicing at a code-point boundary, without allocating an array of a huge body.
  let end = Math.min(text.length, maximum);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  return text.length > end ? `${text.slice(0, end)}… [省略]` : text;
}

export function messagePreview(payload: unknown): string {
  const p = object(payload);
  if (p.role === "toolResult")
    return `工具结果 ${String(p.toolName ?? "")} · ${p.isError ? "错误" : "已返回"}（按消息 ID 展开）`;
  const body =
    typeof p.content === "string"
      ? preview(p.content, 800)
      : !Array.isArray(p.content)
        ? "[非文本消息，按 ID 展开]"
        : p.content
            .map((block: unknown) => {
              const b = object(block);
              if (b.type === "text") return preview(String(b.text ?? ""), 800);
              if (b.type === "toolCall")
                return `调用 ${String(b.name)} ${preview(JSON.stringify(b.arguments), 240)}`;
              if (b.type === "thinking") return "[含思考内容，按 ID 展开]";
              return `[${String(b.type ?? "附件")}，原始数据通过 format=raw 读取]`;
            })
            .join("\n");
  const error = assistantError(p);
  return (
    [error ? `错误：${preview(error, 800)}` : "", body]
      .filter(Boolean)
      .join("\n") || "[无正文，按 ID 展开]"
  );
}

export function messageText(payload: unknown): string {
  const p = object(payload);
  const body =
    typeof p.content === "string"
      ? p.content
      : !Array.isArray(p.content)
        ? JSON.stringify(payload, null, 2)
        : p.content
            .map((block: unknown) => {
              const b = object(block);
              if (b.type === "text") return String(b.text ?? "");
              if (b.type === "thinking")
                return `思考\n${String(b.thinking ?? "")}`;
              if (b.type === "toolCall")
                return `工具调用 ${String(b.name)} (${String(b.id)})\n${JSON.stringify(b.arguments, null, 2)}`;
              return `[${String(b.type ?? "附件")}；编码内容通过 format=raw 读取]`;
            })
            .join("\n\n");
  if (
    p.role === "assistant" &&
    ["error", "aborted", "length"].includes(String(p.stopReason))
  )
    return `${body}\n\n[结束状态：${String(p.stopReason)}]${p.errorMessage ? `\n${String(p.errorMessage)}` : ""}`;
  if (p.role === "toolResult")
    return `工具结果 ${String(p.toolName)} (${String(p.toolCallId)}) · ${p.isError ? "错误" : "已返回"}\n${body}`;
  return body;
}
