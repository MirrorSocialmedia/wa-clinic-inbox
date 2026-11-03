/**
 * ★ cwi-sales 第 4 期：POST /api/admin/sales/month-close/reopen { month } — 重開月結（集團管理員）。
 * 由最後一個月開始；計糧調整嗰個月未鎖先得（workforce 判）。AuditLog SALES_MONTH_REOPENED
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { SalesActionError } from "@/lib/sales/handover";
import { reopenMonth } from "@/lib/sales/close";

export const dynamic = "force-dynamic";

const schema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();

export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以重開月結" }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "資料唔齊" }, { status: 400 });
  try {
    return NextResponse.json(await reopenMonth(parsed.data.month, admin.staff.id));
  } catch (e) {
    if (e instanceof SalesActionError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    throw e;
  }
});
