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

export interface MyPatientView extends PatientRef {
  patientApricotId: string;
  state: "PROTECTED" | "BOUND";
  protectedUntil: string | null;
  lastApptDate: string | null;
  rounds: number;
  noShowStreak: number;
  highValue: boolean;
  /** 保護期仲有幾多日（BOUND = null） */
  daysLeft: number | null;
  since: string;
  /** ★ U3：對話上銷售標嘅意向（HIGH／MEDIUM／LOW；冇 = null） */
  intent: string | null;
}

export interface PoolPatientView extends PatientRef {
  patientApricotId: string;
  /** 放返公海之前係咪你負責 */
  wasMine: boolean;
  since: string;
}

const POOL_DAYS = 60;

/** ★ U1：我負責嘅病人（保護中排最快到期先；綁定排後） */
export async function myPatients(staffId: string, now: Date = new Date()): Promise<MyPatientView[]> {
  const rows = await prisma.salesOwnership.findMany({
    where: { salesStaffId: staffId, state: { in: ["PROTECTED", "BOUND"] } },
    orderBy: [{ state: "asc" }, { protectedUntil: "asc" }, { since: "desc" }], // enum 次序：PROTECTED < BOUND
    take: 300,
  });
  const refs = await patientRefs(rows.map((r) => r.patientApricotId));
  const empty = { patientCode: null, patientName: null, conversationId: null };
  const convIds = [...refs.values()].map((x) => x.conversationId).filter((x): x is string => !!x);
  const intentOf = new Map(
    (await prisma.conversation.findMany({ where: { id: { in: convIds } }, select: { id: true, salesIntent: true } })).map((c) => [c.id, c.salesIntent])
  );
  return rows.map((r) => ({
    intent: intentOf.get(refs.get(r.patientApricotId)?.conversationId ?? "") ?? null,
    patientApricotId: r.patientApricotId,
    state: r.state as "PROTECTED" | "BOUND",
    protectedUntil: r.protectedUntil?.toISOString() ?? null,
    lastApptDate: r.lastApptDate,
    rounds: r.rounds,
    noShowStreak: r.noShowStreak,
    highValue: r.highValue,
    daysLeft: r.state === "PROTECTED" && r.protectedUntil ? Math.max(0, Math.ceil((r.protectedUntil.getTime() - now.getTime()) / 86_400_000)) : null,
    since: r.since.toISOString(),
    ...(refs.get(r.patientApricotId) ?? empty),
  }));
}

/** ★ U2：銷售公海（最近 60 日放返出嚟、冇人負責）— 所有銷售都見到，可以再約 */
export async function salesPool(staffId: string, now: Date = new Date()): Promise<PoolPatientView[]> {
  const rows = await prisma.salesOwnership.findMany({
    where: { state: "POOL", since: { gte: new Date(now.getTime() - POOL_DAYS * 86_400_000) } },
    orderBy: { since: "desc" },
    take: 100,
  });
  const refs = await patientRefs(rows.map((r) => r.patientApricotId));
  const empty = { patientCode: null, patientName: null, conversationId: null };
  return rows.map((r) => ({ patientApricotId: r.patientApricotId, wasMine: r.lastSalesStaffId === staffId, since: r.since.toISOString(), ...(refs.get(r.patientApricotId) ?? empty) }));
}

export async function mySales(staffId: string, month: string) {
  const me = await prisma.staffUser.findUnique({ where: { id: staffId }, select: { isSales: true, active: true } });
  if (!me?.isSales || !me.active) throw new SalesActionError(403, "NOT_SALES", "只有銷售人員有「我的銷售」");
  const { mySalesReviews } = await import("@/lib/sales/reviews");
  const [{ ledger }, invoices, protectedCount, boundCount, patients, pool, reviews] = await Promise.all([
    ledgerView(staffId, month),
    fetchMySalesInvoices(staffId),
    prisma.salesOwnership.count({ where: { salesStaffId: staffId, state: "PROTECTED" } }),
    prisma.salesOwnership.count({ where: { salesStaffId: staffId, state: "BOUND" } }),
    myPatients(staffId),
    salesPool(staffId),
    // 對單結果拎唔到唔阻成頁（傭金數仍然顯示）
    mySalesReviews(staffId).catch(() => null),
  ]);
  const refs = await patientRefs(invoices.map((i) => i.patientApricotId));
  const empty = { patientCode: null, patientName: null, conversationId: null };
  return {
    month,
    counts: { protected: protectedCount, bound: boundCount },
    ledger,
    invoices: invoices.map((i) => ({ ...i, ...(refs.get(i.patientApricotId) ?? empty) })) as InvoiceView[],
    patients,
    pool,
    reviews,
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
