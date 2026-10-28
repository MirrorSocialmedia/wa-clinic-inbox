/**
 * ★ cwi-sales-20261028：老闆管理病人歸屬（/admin/sales「病人歸屬」+ 對話右欄「指派銷售」）。
 *
 * - assign：上線前已有嘅病人 → 直接指派（預設 BOUND；可選 PROTECTED 7 日）
 * - transfer：轉畀另一個銷售（之後嘅付款歸新銷售 — 第 3 期按轉移日計）
 * - release：放返銷售公海
 * 全部留 AuditLog（只 id）+ 定向通知新銷售。
 */
import { Prisma, type SalesOwnershipState } from "@prisma/client";
import prisma from "@/lib/prisma";
import { hkDateOffset } from "@/lib/availability";
import { activeSales, getSalesSettings, notifyStaff, patientConversationIds, protectedUntilFor } from "@/lib/sales/core";
import { SalesActionError } from "@/lib/sales/handover";

export interface OwnershipRow {
  patientApricotId: string;
  patientCode: string | null;
  patientName: string | null;
  state: SalesOwnershipState;
  salesStaffId: string | null;
  salesName: string | null;
  lastSalesName: string | null;
  protectedUntil: string | null;
  rounds: number;
  lastApptDate: string | null;
  since: string;
  conversationId: string | null;
}

export async function listOwnerships(filter: { state?: SalesOwnershipState | null; salesStaffId?: string | null; take?: number }): Promise<OwnershipRow[]> {
  const rows = await prisma.salesOwnership.findMany({
    where: { ...(filter.state ? { state: filter.state } : {}), ...(filter.salesStaffId ? { salesStaffId: filter.salesStaffId } : {}) },
    orderBy: [{ state: "asc" }, { updatedAt: "desc" }],
    take: Math.min(filter.take ?? 300, 1000),
  });
  const staffIds = [...new Set(rows.flatMap((r) => [r.salesStaffId, r.lastSalesStaffId]).filter((x): x is string => !!x))];
  const pids = rows.map((r) => r.patientApricotId);
  const [staff, links] = await Promise.all([
    prisma.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }),
    prisma.contactPatientLink.findMany({ where: { patientApricotId: { in: pids } }, select: { patientApricotId: true, patientCode: true, patientName: true } }),
  ]);
  const nameOf = new Map(staff.map((s) => [s.id, s.name]));
  const linkOf = new Map(links.map((l) => [l.patientApricotId, l]));
  const out: OwnershipRow[] = [];
  for (const r of rows) {
    const l = linkOf.get(r.patientApricotId);
    out.push({
      patientApricotId: r.patientApricotId,
      patientCode: l?.patientCode ?? null,
      patientName: l?.patientName ?? null,
      state: r.state,
      salesStaffId: r.salesStaffId,
      salesName: r.salesStaffId ? (nameOf.get(r.salesStaffId) ?? null) : null,
      lastSalesName: r.lastSalesStaffId ? (nameOf.get(r.lastSalesStaffId) ?? null) : null,
      protectedUntil: r.protectedUntil ? r.protectedUntil.toISOString() : null,
      rounds: r.rounds,
      lastApptDate: r.lastApptDate,
      since: r.since.toISOString(),
      conversationId: (await patientConversationIds(r.patientApricotId))[0] ?? null,
    });
  }
  return out;
}

async function audit(staffId: string, action: string, patientApricotId: string, meta: Record<string, unknown>): Promise<void> {
  await prisma.auditLog.create({ data: { staffId, action, entity: "SalesOwnership", entityId: patientApricotId, meta: meta as Prisma.InputJsonValue } });
}

async function notifyNewOwner(toStaffId: string, patientApricotId: string, title: string): Promise<void> {
  const convId = (await patientConversationIds(patientApricotId))[0];
  if (convId) await notifyStaff([toStaffId], convId, "SALES_PROTECTION", title, { patientApricotId });
}

/** 指派（冇歸屬／公海 → 銷售）；已有其他銷售 → 409（請用 transfer） */
export async function assignOwnership(input: { byStaffId: string; patientApricotId: string; toStaffId: string; state: "BOUND" | "PROTECTED" }): Promise<void> {
  const to = await activeSales(input.toStaffId);
  if (!to) throw new SalesActionError(400, "NOT_SALES", "揀嘅同事唔係有效銷售人員");
  // 只可以指派連住對話嘅病人（防亂打 id 造垃圾歸屬）
  if ((await patientConversationIds(input.patientApricotId)).length === 0) throw new SalesActionError(404, "PATIENT_NOT_FOUND", "搵唔到呢個病人嘅對話");
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: input.patientApricotId } });
  if (own && own.state !== "POOL" && own.salesStaffId && own.salesStaffId !== to.id) {
    throw new SalesActionError(409, "OWNED", "呢個病人已經有銷售負責 — 請用「轉移」");
  }
  const settings = await getSalesSettings();
  const until = input.state === "PROTECTED" ? protectedUntilFor(hkDateOffset(0), settings.protectionDays) : null;
  const data = { state: input.state, salesStaffId: to.id, lastSalesStaffId: to.id, protectedUntil: until, rounds: input.state === "PROTECTED" ? 1 : 0, since: new Date() };
  await prisma.salesOwnership.upsert({ where: { patientApricotId: input.patientApricotId }, create: { patientApricotId: input.patientApricotId, ...data }, update: data });
  await audit(input.byStaffId, "SALES_OWNER_ASSIGNED", input.patientApricotId, { toStaffId: to.id, state: input.state });
  await notifyNewOwner(to.id, input.patientApricotId, input.state === "BOUND" ? "銷售 · 老闆將一個病人綁定畀你" : "銷售 · 老闆將一個病人交畀你跟（保護中）");
}

/** 轉移畀另一個銷售（保留狀態；PROTECTED 嘅到期日唔變） */
export async function transferOwnership(input: { byStaffId: string; patientApricotId: string; toStaffId: string }): Promise<void> {
  const to = await activeSales(input.toStaffId);
  if (!to) throw new SalesActionError(400, "NOT_SALES", "揀嘅同事唔係有效銷售人員");
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: input.patientApricotId } });
  if (!own || own.state === "POOL" || !own.salesStaffId) throw new SalesActionError(409, "NOT_OWNED", "呢個病人冇銷售負責 — 請用「指派」");
  if (own.salesStaffId === to.id) return;
  await prisma.salesOwnership.update({ where: { id: own.id }, data: { salesStaffId: to.id, lastSalesStaffId: to.id, rounds: own.state === "PROTECTED" ? 1 : 0, since: new Date() } });
  await audit(input.byStaffId, "SALES_OWNER_TRANSFERRED", input.patientApricotId, { fromStaffId: own.salesStaffId, toStaffId: to.id, state: own.state });
  await notifyNewOwner(to.id, input.patientApricotId, "銷售 · 老闆將一個病人轉咗畀你");
}

/** 放返銷售公海 */
export async function releaseOwnership(input: { byStaffId: string; patientApricotId: string }): Promise<void> {
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: input.patientApricotId } });
  if (!own || own.state === "POOL") return;
  await prisma.salesOwnership.update({
    where: { id: own.id },
    data: { state: "POOL", salesStaffId: null, lastSalesStaffId: own.salesStaffId, protectedUntil: null, rounds: 0, since: new Date() },
  });
  await audit(input.byStaffId, "SALES_OWNER_RELEASED", input.patientApricotId, { fromStaffId: own.salesStaffId, state: own.state });
}
