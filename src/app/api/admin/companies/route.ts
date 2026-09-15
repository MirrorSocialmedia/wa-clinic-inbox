import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/admin/companies — ADMIN-only（公司清單，cwi-hub-a-20260914 Part A）。
 *
 * UI 用途：員工管理表單「範圍」選擇器（某公司 chip）+ 診所表單公司歸屬下拉。
 * 回：公司（code/name/enabled）+ 旗下診所（id/code/name）。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const companies = await prisma.company.findMany({
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      enabled: true,
      sourceId: true, // cwi-followup-p0-20260915：workforce 快取 key（null = 未配對）
      clinics: {
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      },
    },
  });
  return NextResponse.json(companies);
});
