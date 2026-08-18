import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, clinicScope } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/staff — 員工列表（側欄 assignee 選擇用）。
 * - ?clinicId= 指定店嘅 staff（ADMIN 可以揀任何店；STAFF 只自己店，別店 → 403）
 * - 唔給 clinicId：STAFF → 自己店 staff；ADMIN → 全部
 * 只回 id / name / role / clinicId（assignee 用唔到其他欄位）
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const scope = clinicScope(ctx);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId");

  const where: Record<string, unknown> = { active: true, ...scope };
  if (clinicParam) {
    if (ctx.staff.role === "STAFF" && clinicParam !== ctx.clinicId) {
      return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
    }
    where.clinicId = clinicParam;
  }
  const staff = await prisma.staffUser.findMany({
    where,
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true, clinicId: true },
  });
  return NextResponse.json(staff);
});
