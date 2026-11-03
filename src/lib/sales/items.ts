/**
 * ★ cwi-sales 第 5 期（U6）：傭金項目「套用到所有分店」。
 *
 * 每間店嘅 Apricot 收費項目 id 唔同 → 用項目代碼（code）對返；對唔到嘅代碼（嗰間店冇呢個項目）跳過、回報。
 * 只覆蓋「來源店有設定」嘅代碼（%／類別／高價／計唔計）；目標店其他項目唔郁。逐間店寫（一間失敗唔影響其他）。
 * 舊單唔變（開單嗰刻已鎖 %）。審計：每間店 workforce 記 EXTERNAL_COMMISSION_ITEMS_SET；inbox 記 SALES_ITEMS_COPIED。
 */
import prisma from "@/lib/prisma";
import { fetchCommissionItems, fetchSalesCatalog, putCommissionItems } from "@/lib/workforce/client";
import { SalesActionError } from "@/lib/sales/handover";

export interface CopyResult {
  clinicCode: string;
  applied: number;
  missing: number;
  error: string | null;
}

export async function copyCommissionItemsToAll(fromClinicId: string, staffId: string): Promise<{ from: string; items: number; results: CopyResult[] }> {
  const from = await prisma.clinic.findUnique({ where: { id: fromClinicId }, select: { code: true } });
  if (!from) throw new SalesActionError(404, "CLINIC_NOT_FOUND", "搵唔到呢間店");
  let source;
  try {
    source = (await fetchCommissionItems(from.code)).items;
  } catch {
    throw new SalesActionError(502, "WORKFORCE_UNAVAILABLE", "workforce 連唔到 — 請稍後再試");
  }
  if (source.length === 0) throw new SalesActionError(400, "NOTHING_TO_COPY", "呢間店未設定任何傭金項目");
  const byCode = new Map(source.map((i) => [i.code, i]));
  const targets = await prisma.clinic.findMany({ where: { code: { not: from.code }, apricotClinicId: { not: null } }, orderBy: { code: "asc" }, select: { code: true } });
  const results: CopyResult[] = [];
  for (const t of targets) {
    try {
      const cat = await fetchSalesCatalog(t.code);
      const items = cat.feeItems
        .filter((f) => byCode.has(f.code))
        .map((f) => {
          const s = byCode.get(f.code)!;
          return { feeItemExtId: f.extId, ratePct: s.ratePct, category: s.category, highValue: s.highValue, active: s.active };
        });
      if (items.length > 0) await putCommissionItems(t.code, items, staffId);
      results.push({ clinicCode: t.code, applied: items.length, missing: Math.max(0, byCode.size - items.length), error: null });
    } catch {
      results.push({ clinicCode: t.code, applied: 0, missing: byCode.size, error: "workforce 連唔到／名單未更新" });
    }
  }
  await prisma.auditLog.create({
    data: { staffId, action: "SALES_ITEMS_COPIED", entity: "Clinic", entityId: fromClinicId, meta: { from: from.code, items: source.length, results: results.map((r) => ({ c: r.clinicCode, a: r.applied, e: !!r.error })) } },
  });
  return { from: from.code, items: source.length, results };
}
