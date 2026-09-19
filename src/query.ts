export type ParsedQuery = { clauses: string[][] };

export function parseQuery(input: string): ParsedQuery {
  const tokens: Array<{ kind: "or" } | { kind: "term"; value: string }> = [];
  let i = 0;
  const n = input.length;
  const skipWs = () => {
    while (i < n && /\s/u.test(input[i] ?? "")) i += 1;
  };
  skipWs();
  if (i >= n) return { clauses: [] };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    if (input[i] === '"') {
      i += 1;
      const start = i;
      while (i < n && input[i] !== '"') i += 1;
      if (i >= n) throw new Error("Unclosed quote in query");
      const value = input.slice(start, i).toLowerCase();
      i += 1;
      if (!value) throw new Error("Empty quoted phrase");
      if (i < n && !/\s/u.test(input[i] ?? ""))
        throw new Error("Quoted phrase must be a complete token");
      tokens.push({ kind: "term", value });
      continue;
    }
    const start = i;
    while (i < n && !/\s/u.test(input[i] ?? "") && input[i] !== '"') i += 1;
    if (input[i] === '"') throw new Error("Unexpected quote in query");
    const raw = input.slice(start, i);
    if (raw === "OR") tokens.push({ kind: "or" });
    else tokens.push({ kind: "term", value: raw.toLowerCase() });
  }
  const clauses: string[][] = [[]];
  for (const token of tokens) {
    const last = clauses[clauses.length - 1];
    if (!last) throw new Error("OR needs terms on both sides");
    if (token.kind === "or") {
      if (last.length === 0) throw new Error("OR needs terms on both sides");
      clauses.push([]);
      continue;
    }
    last.push(token.value);
  }
  if ((clauses[clauses.length - 1] ?? []).length === 0)
    throw new Error("OR needs terms on both sides");
  return { clauses };
}

export function queryMatches(haystack: string, query: ParsedQuery): boolean {
  if (query.clauses.length === 0) return true;
  const lower = haystack.toLowerCase();
  return query.clauses.some((clause) =>
    clause.every((term) => lower.includes(term)),
  );
}

export function queryHitIndex(haystack: string, query: ParsedQuery): number {
  const lower = haystack.toLowerCase();
  for (const clause of query.clauses) {
    if (clause.every((term) => lower.includes(term)))
      return lower.indexOf(clause[0] ?? "");
  }
  return -1;
}

export function querySql(
  expr: string,
  query: ParsedQuery,
): { sql: string; values: string[] } | undefined {
  if (query.clauses.length === 0) return;
  const parts = query.clauses.map((clause) => {
    const bits = clause.map(() => `instr(${expr},?)>0`);
    return bits.length === 1 ? (bits[0] ?? "0") : `(${bits.join(" AND ")})`;
  });
  return {
    sql: parts.length === 1 ? (parts[0] ?? "0") : `(${parts.join(" OR ")})`,
    values: query.clauses.flat(),
  };
}
