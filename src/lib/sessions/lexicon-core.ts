/**
 * ★ cwi-auditfix-20260908（H-1）：lexicon 純核心（client-safe — 零 DB/zero import）。
 *
 * 拆出原因：路由引擎（server）同規則編輯 UI（client）都要做「關鍵詞 canonical 化」：
 * - 引擎：matchRule 關鍵詞雙比對（raw ∨ canonical）— 見 route.ts
 * - UI：規則編輯面板關鍵詞 chip 旁顯示 canonical 形式（管理員睇到口語表會點改佢）
 * 兩邊共用同一份 pure 實現 → 行為一致（longest-term-first、唔命中保留原文、全替換）。
 */

export interface LexiconEntry {
  term: string;
  canonical: string;
  note?: string;
}

/**
 * canonical 化（紅旗 match 前必經）。longest-term-first 防短詞先食咗一截；
 * 唔命中 → 原文；term 出現多次 → 全部替換（client-side，冇 DB 參與）。
 */
export function applyLexicon(text: string, entries: LexiconEntry[]): string {
  if (!text || entries.length === 0) return text;
  const sorted = [...entries].sort((a, b) => b.term.length - a.term.length);
  let out = text;
  for (const e of sorted) {
    if (e.term === e.canonical) continue;
    out = out.split(e.term).join(e.canonical);
  }
  return out;
}

/** prompt 注入用：人話術語對清單（「cool牙 → 矯齒」）。 */
export function lexiconPromptBlock(entries: LexiconEntry[]): string {
  if (entries.length === 0) return "";
  return (
    "\n\n【術語對照（病人口語 → 正式術語 — 理解時按 canonical 解）】\n" +
    entries.map((e) => `- ${e.term} → ${e.canonical}`).join("\n")
  );
}
