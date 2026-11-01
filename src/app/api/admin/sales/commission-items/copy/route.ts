/**
 * ★ cwi-sales 第 5 期（U6）：POST /api/admin/sales/commission-items/copy — 將一間店嘅傭金項目設定套用到所有分店（集團管理員）。
 * body { fromClinicId } → { from, items, results[{ clinicCode, applied, missing, error }] }。項目用代碼對返；舊單唔變。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { SalesActionError } from "@/lib/sales/handover";
import { copyCommissionItemsToAll } from "@/lib/sales/items";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ fromClinicId: z.string().min(1).max(64) }).strict();

export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以改傭金項目" }, { status: 403 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "要揀來源分店" }, { status: 400 });
  try {
    return NextResponse.json(await copyCommissionItemsToAll(parsed.data.fromClinicId, admin.staff.id));
  } catch (err) {
    if (err instanceof SalesActionError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    throw err;
  }
});
