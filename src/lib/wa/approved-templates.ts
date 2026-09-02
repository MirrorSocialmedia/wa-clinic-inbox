import { listMessageTemplates, waMock, type MessageTemplate } from "@/lib/wa/graph";

/**
 * APPROVED + UTILITY template 名單（cwi-window-20260901 P3：
 * send route 422 回應 + template 發送校驗 + 過窗 picker 共用 — 單一來源避免 drift）。
 * 失敗回 []（唔阻 caller）。
 */
export async function approvedTemplateList(clinic: {
  waBusinessAccountId: string | null;
}): Promise<MessageTemplate[]> {
  try {
    if (!clinic.waBusinessAccountId && !waMock()) return [];
    const all = await listMessageTemplates(clinic.waBusinessAccountId ?? "");
    return all.filter((t) => t.status === "APPROVED" && t.category === "UTILITY");
  } catch {
    return [];
  }
}
