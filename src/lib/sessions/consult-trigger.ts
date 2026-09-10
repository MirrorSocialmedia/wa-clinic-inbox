/**
 * ★ consult v2.1 C1（MD §2.2 M-2）：CONSULT session trigger — code 常數 FLOOR + deterministic 匹配。
 *
 * 設計（MD §2.2）：classify 輸出加 `sessionTrigger`（同一個 LLM call），**但唔准淨靠 LLM** —
 * FLOOR 係 code 常數（UI 顯示但唔可刪），最終值 = `floor ?? llmSessionTrigger`（floor 優先）。
 *
 * - `triggerFloor(textRaw, textCanonical)`：比對 **lexicon canonical 後文字 ∪ 原文**，大小寫不敏感。
 *   返邊個 workflow 命中（多 workflow 同中 → 取 Record 插入序第一個 — deterministic）；都唔中 → null。
 * - 純函數（零 IO）— 可單測。PII：詞表係 code 常數，零病人資料；輸入文字只喺 memory 內比對。
 */

/** MD §2.2 逐字 — FLOOR 詞表（code 常數；UI 顯示但唔可刪）。 */
export const CONSULT_TRIGGER_FLOOR: Record<string, string[]> = {
  ORTHODONTIC_CONSULT: ["矯齒", "箍牙", "牙箍", "cool牙", "invisalign", "隱適美", "隱形牙箍", "牙套矯正"],
  IMPLANT_CONSULT: ["植牙", "種牙", "種植牙", "implant", "植體"],
};

/** session trigger 值（= workflow key；null = 非 consult）。 */
export type ConsultTrigger = "ORTHODONTIC_CONSULT" | "IMPLANT_CONSULT";

/**
 * FLOOR 匹配：canonical 後文字 ∪ 原文，大小寫不敏感。
 * @param textRaw       病人訊息原文（pre-normalize）
 * @param textCanonical lexicon 正規化後文字（applyLexicon 結果）
 * @returns 命中嘅 workflow key（"ORTHODONTIC_CONSULT" | "IMPLANT_CONSULT"）；都唔中 → null
 */
export function triggerFloor(textRaw: string, textCanonical: string): string | null {
  const raw = (textRaw ?? "").toLowerCase();
  const canonical = (textCanonical ?? "").toLowerCase();
  for (const [workflow, terms] of Object.entries(CONSULT_TRIGGER_FLOOR)) {
    for (const term of terms) {
      const t = term.toLowerCase();
      if (t.length === 0) continue;
      if (raw.includes(t) || canonical.includes(t)) return workflow;
    }
  }
  return null;
}
