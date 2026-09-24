import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/staff — 員工列表（側欄 assignee 選擇用）。
 * - ?clinicId= 指定店嘅 staff（scope-aware — 外範圍 clinicId → 403 任何受限角色）
 * - 唔給 clinicId：S3-9 — 按 scope filter（scopedClinicSet — STAFF 只見自己店 staff；
 *   ALL/SUPERVISOR 無 scope 概念 → 全部 active staff）。
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
  } else {
    // S3-9：唔帶 clinicId → 按 scope filter（null = ALL/SUPERVISOR 全店）
    const set = scopedClinicSet(ctx);
    if (set) where.clinicId = { in: set };
  }
  const staff = await prisma.staffUser.findMany({
    where,
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true, clinicId: true },
  });
  return NextResponse.json(staff);
});
