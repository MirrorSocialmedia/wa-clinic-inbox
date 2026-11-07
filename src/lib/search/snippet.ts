/**
 * ★ cwi-search-20261107：搜尋結果片段 — 由命中位置前後截取（唔再淨係攞頭 80 字：命中字喺後面就睇唔到）。
 * 唔分大小寫；搵唔到（例如命中電話號碼而唔係內文）→ 回頭 N 字。純函數（可 unit test）。
 */
export function snippetAround(body: string | null | undefined, q: string, radius = 36): string | null {
  if (!body) return null;
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const needle = q.trim().toLowerCase();
  const idx = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (idx < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** LIKE/ILIKE 萬用字 escape（% _ \）— q 照樣 bind parameter，呢度只係保字面語義 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
