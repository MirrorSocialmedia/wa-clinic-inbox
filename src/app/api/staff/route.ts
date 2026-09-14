import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/staff — 員工列表（側欄 assignee 選擇用）。
 * - ?clinicId= 指定店嘅 staff（ADMIN 可以揀任何店；STAFF 只能查自己綁定店之一，否則 → 403）
 * - 唔給 clinicId：全部 active staff — cwi-h6-20260830 權限矩陣 ASSIGN/RELEASE target = 任何
 *   active STAFF/ADMIN（包括完全外店），所以 picker 必須列齊（跨店由 assign 端
 *   assertCanAssign + assertConversationAccess 守，唔靠 picker 過濾）。
 * 只回 id / name / role / clinicId（assignee 用唔到其他欄位）
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId");

  const where: Record<string, unknown> = { active: true };
  if (clinicParam) {
    // ★ cwi-hub-a-20260914（Part A）：scope-aware — 外範圍 clinicId → 403（任何受限角色）
    assertClinicAccess(ctx, clinicParam);
    where.clinicId = clinicParam;
  }
  const staff = await prisma.staffUser.findMany({
    where,
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true, clinicId: true },
  });
  return NextResponse.json(staff);
});
