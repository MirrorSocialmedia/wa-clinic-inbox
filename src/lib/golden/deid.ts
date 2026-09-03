/**
 * ★ Part F（cwi-raggolden-20260904，MD §Part F F.5）：GoldenCase 去識別化（入庫前**強制**）。
 *
 * 規則（MD 原文）：
 * - 電話（8 位數字串 / +852）→ `<phone>`
 * - 姓名（比對 contactName + profileName）→ `<name>`
 * - 日期同金額保留（eval 要答「幾錢」— 金額係業務事實唔係 PII）
 * - **唔存 conversationId/messageId**（零 PII + 避免原對話 purge 後穿窿）— 結構層保證（GoldenCase 無呢兩欄）
 *
 * 純函數、deterministic、零 IO — 可單測。
 */

/** +852 前綴電話（+852 1234 5678 / +85212345678 / 852-1234-5678）→ <phone> */
const RE_PHONE_852 = /\+?852[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g;
/** 裸 8 位數字串（HK 手機）→ <phone>（前後唔可以係其他數字 — 保金額/日期數字） */
const RE_PHONE_8 = /(?<!\d)\d{8}(?!\d)/g;

/**
 * 去識別化。
 * @param text  原文（病人訊息）
 * @param names 要撳走嘅姓名集（contactName + profileName；空 = 只撳電話）
 */
export function deid(text: string, names: string[] = []): string {
  if (!text) return "";
  let out = text;
  // 1. 電話（先 +852 形態，再裸 8 位）
  out = out.replace(RE_PHONE_852, "<phone>");
  out = out.replace(RE_PHONE_8, "<phone>");
  // 2. 姓名（longest-first 防短名先食一截；完整字串替換 — 唔做 partial match）
  const uniq = [...new Set(names.map((n) => (n ?? "").trim()).filter((n) => n.length > 0))].sort(
    (a, b) => b.length - a.length
  );
  for (const n of uniq) {
    out = out.split(n).join("<name>");
  }
  return out;
}

/**
 * 批次去識別化（contextBefore 用）。
 */
export function deidList(texts: (string | null | undefined)[], names: string[] = []): string[] {
  return texts.map((t) => deid(t ?? "", names)).filter((t) => t.trim().length > 0);
}
