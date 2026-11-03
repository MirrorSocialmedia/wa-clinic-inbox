/**
 * ★ cwi-sales 第 5 期：POST /api/sales/reviews/[id]/note — 銷售補充對單／申訴原因（例：開單日冇打卡點解）。
 * body { note: 1–500 字 }。只限銷售本人張單、老闆未決定；Apricot 銷售員帳號由登入帳號攞（唔信 client）。
 * 審計 SALES_REVIEW_NOTE（只記長度，唔記內容）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { SalesActionError } from "@/lib/sales/handover";
import { addSalesNote } from "@/lib/sales/reviews";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ note: z.string().min(1).max(500) }).strict();

export const POST = handle(async (req: NextRequest, ctxP: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctxP.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "補充內容 1–500 字" }, { status: 400 });
  try {
    await addSalesNote(id, parsed.data.note, auth.staff.id);
  } catch (err) {
    if (err instanceof SalesActionError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    throw err;
  }
  return NextResponse.json({ ok: true });
});
