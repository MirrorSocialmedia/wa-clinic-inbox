/**
 * ★ cwi-sales 第 4 期：GET /api/admin/sales/report?month=YYYY-MM — 傭金報表 CSV（集團管理員）。
 * 每個銷售（出糧／結轉）、每間店、每筆明細；只有病人編號（冇名）；防 CSV 公式注入。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { SalesActionError } from "@/lib/sales/handover";
import { reportCsv } from "@/lib/sales/close";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以下載報表" }, { status: 403 });
  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ error: "BAD_MONTH", message: "月份格式唔啱" }, { status: 400 });
  try {
    const csv = await reportCsv(month);
    await import("@/lib/prisma").then(({ default: prisma }) =>
      prisma.auditLog.create({ data: { staffId: admin.staff.id, action: "SALES_REPORT_EXPORTED", entity: "SalesMonth", entityId: month } })
    );
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="sales-commission-${month}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof SalesActionError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    throw e;
  }
});
