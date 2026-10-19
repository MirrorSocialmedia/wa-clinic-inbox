import { listMessageTemplates, waMock, type MessageTemplate } from "@/lib/wa/graph";

/**
 * APPROVED template 名單（**全部 category** — cwi-final S2-5：回傳 `{ name, category, ... }`，
 * 由 caller 決定邊個類別可用）。
 *
 * 背景：舊版只收 UTILITY（cwi-window-20260901 P3）— 但過窗 followup template 發送要照
 * Meta 回傳嘅**真 category** 計費（MARKETING 就記 MARKETING — 收費較高，UI 要提示），
 * 只收 UTILITY 會令 Meta APPROVED 嘅 MARKETING template 永遠匹配唔到。
 *
 * caller 現狀：
 * - `followup/engine.ts sendFollowupTask`（S2-5）：name 匹配 + 真 category → templateMeta/billingCategory。
 * - `api/conversations/[id]/templates`（過窗 picker）：caller 層 filter 返 UTILITY
 *   （v1 只發得起 reminder/confirm 兩款 builder — MARKETING 列咗都發唔出，唔好迷惑員工）。
 *
 * 失敗回 []（唔阻 caller）。
 */
export async function approvedTemplateList(clinic: {
  waBusinessAccountId: string | null;
}): Promise<MessageTemplate[]> {
  try {
    const wabaId = clinicWabaId(clinic);
    if (!wabaId && !waMock()) return [];
    const all = await listMessageTemplates(wabaId ?? "");
    return all.filter((t) => t.status === "APPROVED");
  } catch {
    return [];
  }
}

/**
 * ★ 擁有人 2026-10-18：店冇自己 WABA id → 用 .env WA_WABA_ID（同「訊息範本」頁同一來源）。
 * 以前過窗 picker 只睇 clinic.waBusinessAccountId — 未填就成張名單空白，但範本頁又見到一大堆 APPROVED。
 */
export function clinicWabaId(clinic: { waBusinessAccountId: string | null }): string | null {
  return clinic.waBusinessAccountId || process.env.WA_WABA_ID?.trim() || null;
}

/**
 * 冇任何變數嘅 template（hello_world 類）：唔使 builder 就發得 — components 送空陣列。
 * 判斷：有 components（mock 舊 fixture 冇 → false）、冇 {{n}}、header 只可以係純文字（圖片/影片/文件 header 要 media 參數）。
 */
export function isPlainTemplate(t: MessageTemplate): boolean {
  if (!t.components || t.components.length === 0) return false;
  if (JSON.stringify(t.components).includes("{{")) return false;
  return t.components.every((c) => c.type !== "HEADER" || !c.format || c.format === "TEXT");
}

/** 冇變數 template 嘅顯示文字（落 Message.body / picker 預覽）：header + body + footer 照 Meta 原文。 */
export function plainTemplatePreview(t: MessageTemplate): string {
  const pick = (type: string) => t.components?.find((c) => c.type === type)?.text?.trim() ?? "";
  return [pick("HEADER"), pick("BODY"), pick("FOOTER")].filter(Boolean).join("\n");
}
