/**
 * ★ cwi-sales-20261028：GET /api/admin/sales/catalog?clinicId= — 分店收費項目 + 醫生 + 傭金（workforce 每晚同步名單；ADMIN）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchSalesCatalog, WorkforceApiError } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const clinicId = req.nextUrl.searchParams.get("clinicId") ?? "";
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { code: true } });
  if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 404 });
  try {
    return NextResponse.json({ catalog: await fetchSalesCatalog(clinic.code) });
  } catch (err) {
    const status = err instanceof WorkforceApiError ? err.status : 0;
    return NextResponse.json({ error: "WORKFORCE_UNAVAILABLE", message: status === 404 ? "workforce 冇呢間店" : "workforce 連唔到 — 請稍後再試" }, { status: 502 });
  }
});
