/**
 * ★ cwi-sales 第 4 期：/api/admin/sales/month-close — 老闆月結（集團管理員）。
 * GET ?month=YYYY-MM → 預覽（每個銷售 已計／結轉／出糧；擋住原因；月結前同步狀態）
 * POST { month, force? } → 月結（workforce 入計糧調整）；AuditLog SALES_MONTH_CLOSED
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { SalesActionError } from "@/lib/sales/handover";
import { closeMonth, monthCloseView } from "@/lib/sales/close";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const postSchema = z.object({ month: z.string().regex(MONTH), force: z.boolean().optional() }).strict();
const err = (e: unknown) => {
  if (e instanceof SalesActionError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  throw e;
};

export const GET = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以月結" }, { status: 403 });
  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return NextResponse.json({ error: "BAD_MONTH", message: "月份格式唔啱" }, { status: 400 });
  try {
    return NextResponse.json(await monthCloseView(month));
  } catch (e) {
    return err(e);
  }
});

export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以月結" }, { status: 403 });
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "資料唔齊" }, { status: 400 });
  try {
    return NextResponse.json(await closeMonth(parsed.data.month, parsed.data.force ?? false, admin.staff.id));
  } catch (e) {
    return err(e);
  }
});
