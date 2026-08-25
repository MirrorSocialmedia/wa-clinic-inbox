/**
 * GET /api/admin/suggestions — 學習迴路 review queue（Phase E，cwi-ai-20260825-t5）。
 *
 * ?status=PROPOSED|APPROVED|REJECTED 過濾；唔傳 = 全部（PROPOSED 先，其次時間倒序）。
 * requireAdmin（D-6：建議卡只俾 admin 審）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const VALID = new Set(["PROPOSED", "APPROVED", "REJECTED"]);
const RANK: Record<string, number> = { PROPOSED: 0, APPROVED: 1, REJECTED: 2 };

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const where = status && VALID.has(status) ? { status } : {};
  const rows = await prisma.suggestionCard.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }], // 粗排序；PROPOSED 喺前（同 status 內時間倒序）
    take: 200,
  });
  const sorted = [...rows].sort((a, b) => {
    const r = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9);
    return r !== 0 ? r : b.createdAt.getTime() - a.createdAt.getTime();
  });
  return NextResponse.json({ suggestions: sorted });
});
