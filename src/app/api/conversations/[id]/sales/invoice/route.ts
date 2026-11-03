/**
 * ★ cwi-sales 第 2 期：/api/conversations/[id]/sales/invoice — 對話右欄「開單」。
 *
 * GET  ?clinicCode=XXX（★ 第 5 期：揀開單分店；預設對話處理中分店）
 *      → { context: { blocked, clinicCode, clinics[{code,name}], patients[] }, options: { practitioners, feeItems(+ratePct), paymentMethods, writeEnabled, templateReady } | null, optionsError }
 * POST body { requestKey, clinicCode?, patientApricotId, practitionerExtId, lines[{ feeItemExtId, qty, up, discAmt, remarks? }], payment?: { amt, methodExtId } }
 *      → { invoice: { billCode, totalAmt, paymentAmt, commissionableAmt, review, replayed, recovered, bound } }
 *      同 requestKey 重撳 = 重放（唔會開兩張）；504 UNCONFIRMED = 1 分鐘後用同一 requestKey 再撳。
 *
 * 權限：requireAuth + 對話 scope + 寫權（SUPERVISOR 403）；銷售本人／Apricot 綁定／病人歸屬由 lib 判。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess, assertCanWriteConversation, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { SalesActionError } from "@/lib/sales/handover";
import { invoiceOptionsFor, openSalesInvoice } from "@/lib/sales/invoice";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const lineSchema = z.object({
  feeItemExtId: z.string().min(1).max(64),
  qty: z.number().int().min(1).max(999),
  up: z.number().min(0).max(10_000_000),
  discAmt: z.number().min(0).max(10_000_000),
  remarks: z.string().max(200).nullish(),
});
const postSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
    clinicCode: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/).nullish(),
    patientApricotId: z.string().min(1).max(64),
    practitionerExtId: z.string().min(1).max(64),
    lines: z.array(lineSchema).min(1).max(30),
    payment: z.object({ amt: z.number().min(0).max(10_000_000), methodExtId: z.string().min(1).max(64) }).nullish(),
  })
  .strict();

async function loadConv(req: NextRequest, ctxP: Ctx) {
  const auth = await requireAuth(req);
  const { id } = await ctxP.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return { auth, conv: null };
  await assertConversationAccess(auth, conv);
  return { auth, conv };
}

export const GET = handle(async (req: NextRequest, ctxP: Ctx) => {
  const { auth, conv } = await loadConv(req, ctxP);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const code = req.nextUrl.searchParams.get("clinicCode");
    if (code !== null && !/^[A-Za-z0-9_-]{1,16}$/.test(code)) return NextResponse.json({ error: "bad_request", message: "分店編號唔啱" }, { status: 400 });
    return NextResponse.json(await invoiceOptionsFor(conv.id, auth.staff.id, { scope: scopedClinicSet(auth), clinicCode: code }));
  } catch (err) {
    if (err instanceof SalesActionError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    throw err;
  }
});

export const POST = handle(async (req: NextRequest, ctxP: Ctx) => {
  const { auth, conv } = await loadConv(req, ctxP);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertCanWriteConversation(auth);
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "開單資料唔齊" }, { status: 400 });
  const b = parsed.data;
  try {
    const invoice = await openSalesInvoice({
      conversationId: conv.id,
      staffId: auth.staff.id,
      requestKey: b.requestKey,
      scope: scopedClinicSet(auth),
      clinicCode: b.clinicCode ?? null,
      patientApricotId: b.patientApricotId,
      practitionerExtId: b.practitionerExtId,
      lines: b.lines,
      payment: b.payment ?? null,
    });
    return NextResponse.json({
      invoice: {
        billCode: invoice.billCode,
        totalAmt: invoice.totalAmt,
        paymentAmt: invoice.paymentAmt,
        commissionableAmt: invoice.commissionableAmt,
        review: invoice.review,
        replayed: invoice.replayed,
        recovered: invoice.recovered,
        bound: invoice.bound,
        highValueExtended: invoice.highValueExtended,
      },
    });
  } catch (err) {
    if (err instanceof SalesActionError) {
      return NextResponse.json(
        { error: err.code, message: err.message, ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}) },
        { status: err.status }
      );
    }
    throw err;
  }
});
