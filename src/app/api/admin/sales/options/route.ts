/**
 * ★ cwi-sales-20261028：GET /api/admin/sales/options — 員工表單「☑ 銷售人員」揀選項（ADMIN）。
 * → { apricotUsers: [{ extId, name, login, account }], employees: [{ id, name, clinicCodes }], error? }
 * 來源 = workforce 每晚同步嘅 Apricot 用戶 + 在職員工；workforce 連唔到 → 200 + 空清單 + error（表單照開）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchSalesApricotUsers, fetchSalesEmployees } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const [u, e] = await Promise.allSettled([fetchSalesApricotUsers(), fetchSalesEmployees()]);
  return NextResponse.json({
    apricotUsers: u.status === "fulfilled" ? u.value.users : [],
    employees: e.status === "fulfilled" ? e.value.employees : [],
    ...(u.status === "rejected" || e.status === "rejected" ? { error: "workforce 連唔到 — 名單暫時拎唔到" } : {}),
  });
});
