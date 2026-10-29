/**
 * ★ cwi-sales 第 2 期：老闆對單隊列（workforce SalesReview）+ inbox 補返銷售名、病人編號、對話連結。
 *
 * kind：RECONCILE_UNPROTECTED（保護外病人開單）／RECONCILE_DIRECT（Apricot 直接開兼填銷售員）／
 *       RECONCILE_MISMATCH（inbox 開嘅單，Apricot 上銷售員被改咗）
 * 決定：APPROVED（可批部分 %）／REJECTED（要原因）— 只限集團管理員；workforce 判冪等／並發。
 */
import prisma from "@/lib/prisma";
import { patientConversationIds } from "@/lib/sales/core";
import { decideSalesReview, fetchSalesReviews, type SalesReviewRow } from "@/lib/workforce/client";
import { SalesActionError } from "@/lib/sales/handover";

export interface ReviewView extends SalesReviewRow {
  salesStaffName: string | null;
  patientCode: string | null;
  patientName: string | null;
  conversationId: string | null;
}

export async function listSalesReviews(status: string | null): Promise<ReviewView[]> {
  const rows = await fetchSalesReviews(status);
  const salesIds = [...new Set(rows.map((r) => r.salesApricotUserId).filter((x): x is string => !!x))];
  const pids = [...new Set(rows.map((r) => r.patientApricotId).filter((x): x is string => !!x))];
  const [staff, links] = await Promise.all([
    prisma.staffUser.findMany({ where: { salesApricotUserId: { in: salesIds } }, select: { name: true, salesApricotUserId: true } }),
    prisma.contactPatientLink.findMany({ where: { patientApricotId: { in: pids } }, select: { patientApricotId: true, patientCode: true, patientName: true } }),
  ]);
  const staffOf = new Map(staff.map((s) => [s.salesApricotUserId!, s.name]));
  const linkOf = new Map(links.map((l) => [l.patientApricotId, l]));
  const convOf = new Map<string, string | null>();
  for (const pid of pids.slice(0, 200)) convOf.set(pid, (await patientConversationIds(pid))[0] ?? null);
  return rows.map((r) => {
    const l = r.patientApricotId ? linkOf.get(r.patientApricotId) : undefined;
    return {
      ...r,
      salesStaffName: r.salesApricotUserId ? (staffOf.get(r.salesApricotUserId) ?? null) : null,
      patientCode: l?.patientCode ?? null,
      patientName: l?.patientName ?? null,
      conversationId: r.patientApricotId ? (convOf.get(r.patientApricotId) ?? null) : null,
    };
  });
}

/**
 * 老闆決定：RECONCILE_DIRECT 批 → 由 Apricot 銷售員 id 對返 inbox 銷售帳號（收養張單入傭金追蹤）；
 * 對唔返（未綁）→ 409，唔會批咗之後冇人收傭金。
 */
export async function decideReviewFromInbox(
  id: string,
  body: { decision: "APPROVED" | "REJECTED"; approvedPct?: number | null; note?: string | null },
  byStaffId: string
): Promise<void> {
  let adopt: { inboxStaffId: string; employeeId: string | null } | null = null;
  if (body.decision === "APPROVED") {
    const r = (await fetchSalesReviews("OPEN")).find((x) => x.id === id);
    if (r?.kind === "RECONCILE_DIRECT") {
      const staff = r.salesApricotUserId
        ? await prisma.staffUser.findUnique({ where: { salesApricotUserId: r.salesApricotUserId }, select: { id: true, isSales: true, active: true, workforceEmployeeId: true } })
        : null;
      if (!staff?.isSales || !staff.active) throw new SalesActionError(409, "SALES_NOT_BOUND", "呢張單嘅 Apricot 銷售員未綁 inbox 銷售帳號 — 請先喺員工帳號綁定，或者拒絕");
      adopt = { inboxStaffId: staff.id, employeeId: staff.workforceEmployeeId };
    }
  }
  await decideSalesReview(id, { ...body, adopt }, byStaffId);
}
