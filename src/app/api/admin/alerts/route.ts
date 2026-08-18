import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/admin/alerts — 警報列表（ADMIN-only，fail-closed）。
 *
 * ?resolved=false（預設）= 只未解決；?all=1 = 連已解決（最近 100 條）。
 * 回傳 metadata only（type/severity/clinic/detail/時間）— 零訊息原文。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const p = req.nextUrl.searchParams;
  const all = p.get("all") === "1";

  const alerts = await prisma.alert.findMany({
    where: all ? {} : { resolvedAt: null },
    orderBy: [{ resolvedAt: "asc" }, { createdAt: "desc" }], // 未解決先（null 排頭），再新先
    take: 100,
  });

  return NextResponse.json({
    alerts: alerts.map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      clinicId: a.clinicId,
      clinicCode: a.clinicCode,
      detail: a.detail,
      createdAt: a.createdAt,
      resolvedAt: a.resolvedAt,
    })),
  });
});
