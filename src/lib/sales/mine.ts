/**
 * ★ cwi-sales 第 3 期：「我的銷售」（銷售只見自己）+ 老闆傭金總覽。
 *
 * 數據：workforce 傭金分類帳（每晚同步：每張單一次 bills/{id}）+ inbox 歸屬（保護中／綁定數）。
 * inbox 補返病人編號／名（ContactPatientLink 白名單）同對話連結；workforce 只有 Apricot 病人 id。
 */
import prisma from "@/lib/prisma";
import { patientConversationIds } from "@/lib/sales/core";
import { SalesActionError } from "@/lib/sales/handover";
import { fetchMySalesInvoices, fetchSalesLedger, fetchSalesLedgerSummary, type MySalesInvoice, type SalesLedger } from "@/lib/workforce/client";

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const hkMonthNow = (d: Date = new Date()): string => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 7);

interface PatientRef {
  patientCode: string | null;
  patientName: string | null;
  conversationId: string | null;
}

async function patientRefs(ids: string[]): Promise<Map<string, PatientRef>> {
  const uniq = [...new Set(ids.filter(Boolean))].slice(0, 300);
  const links = await prisma.contactPatientLink.findMany({ where: { patientApricotId: { in: uniq } }, select: { patientApricotId: true, patientCode: true, patientName: true } });
  const linkOf = new Map(links.map((l) => [l.patientApricotId, l]));
  const out = new Map<string, PatientRef>();
  for (const id of uniq) {
    const l = linkOf.get(id);
    out.set(id, { patientCode: l?.patientCode ?? null, patientName: l?.patientName ?? null, conversationId: (await patientConversationIds(id))[0] ?? null });
  }
  return out;
}

export type LedgerRowView = SalesLedger["rows"][number] & PatientRef;
export type InvoiceView = MySalesInvoice & PatientRef;

export async function ledgerView(staffId: string, month: string): Promise<{ ledger: Omit<SalesLedger, "rows" | "v"> & { rows: LedgerRowView[] } }> {
  const l = await fetchSalesLedger(staffId, month);
  const refs = await patientRefs(l.rows.map((r) => r.patientApricotId ?? ""));
  const empty = { patientCode: null, patientName: null, conversationId: null };
  return { ledger: { month: l.month, closed: l.closed, totals: l.totals, rows: l.rows.map((r) => ({ ...r, ...(refs.get(r.patientApricotId ?? "") ?? empty) })) } };
}

export async function mySales(staffId: string, month: string) {
  const me = await prisma.staffUser.findUnique({ where: { id: staffId }, select: { isSales: true, active: true } });
  if (!me?.isSales || !me.active) throw new SalesActionError(403, "NOT_SALES", "只有銷售人員有「我的銷售」");
  const [{ ledger }, invoices, protectedCount, boundCount] = await Promise.all([
    ledgerView(staffId, month),
    fetchMySalesInvoices(staffId),
    prisma.salesOwnership.count({ where: { salesStaffId: staffId, state: "PROTECTED" } }),
    prisma.salesOwnership.count({ where: { salesStaffId: staffId, state: "BOUND" } }),
  ]);
  const refs = await patientRefs(invoices.map((i) => i.patientApricotId));
  const empty = { patientCode: null, patientName: null, conversationId: null };
  return {
    month,
    counts: { protected: protectedCount, bound: boundCount },
    ledger,
    invoices: invoices.map((i) => ({ ...i, ...(refs.get(i.patientApricotId) ?? empty) })) as InvoiceView[],
  };
}

/** 老闆：當月每個銷售合計（有分類帳嘅 + 所有 active 銷售，冇數都列 0） */
export async function commissionSummary(month: string) {
  const s = await fetchSalesLedgerSummary(month);
  const sales = await prisma.staffUser.findMany({ where: { OR: [{ isSales: true }, { id: { in: s.sales.map((x) => x.inboxStaffId) } }] }, select: { id: true, name: true, active: true, isSales: true } });
  const byId = new Map(s.sales.map((x) => [x.inboxStaffId, x]));
  const zero = { counted: 0, held: 0, excluded: 0, rejected: 0, lines: 0 };
  return {
    month,
    closed: s.closed,
    rows: sales
      .map((st) => ({ staffId: st.id, name: st.name, active: st.active && st.isSales, ...(byId.get(st.id) ?? zero) }))
      .sort((a, b) => b.counted - a.counted || a.name.localeCompare(b.name)),
  };
}
