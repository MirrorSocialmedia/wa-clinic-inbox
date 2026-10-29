/**
 * ★ cwi-sales 第 2 期：老闆對單隊列（workforce SalesReview）+ inbox 補返銷售名、病人編號、對話連結。
 *
 * kind：RECONCILE_UNPROTECTED（保護外病人開單）／RECONCILE_DIRECT（Apricot 直接開兼填銷售員）／
 *       RECONCILE_MISMATCH（inbox 開嘅單，Apricot 上銷售員被改咗）
 * 決定：APPROVED（可批部分 %）／REJECTED（要原因）— 只限集團管理員；workforce 判冪等／並發。
 */
import prisma from "@/lib/prisma";
import { patientConversationIds } from "@/lib/sales/core";
import { fetchSalesReviews, type SalesReviewRow } from "@/lib/workforce/client";

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
