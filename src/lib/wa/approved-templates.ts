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
    if (!clinic.waBusinessAccountId && !waMock()) return [];
    const all = await listMessageTemplates(clinic.waBusinessAccountId ?? "");
    return all.filter((t) => t.status === "APPROVED");
  } catch {
    return [];
  }
}
