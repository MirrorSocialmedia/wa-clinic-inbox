/**
 * ★ cwi-sales 第 5 期（U9）：/api/sales/invoice — 冇對話開單（walk-in／前台轉介病人）。
 *
 * GET  ?patientApricotId=&clinicCode= → 同對話版一樣嘅 { context, options, optionsError }
 * POST body { requestKey, clinicCode?, patientApricotId, practitionerExtId, lines[], payment? } → { invoice }
 * 病人一定要係自己 15 分鐘內搜過（server 記低嘅搜尋結果 — 編號／名唔信 client）；其他規則同對話版
 * （只限銷售、其他銷售負責 → 403、冇人負責 → 老闆對單、同 requestKey 重撳 = 重放）。分店喺自己範圍內揀。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, assertCanWriteConversation, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { recallSearchHit } from "@/lib/patient-links";
import { SalesActionError } from "@/lib/sales/handover";
import { DIRECT_SEARCH_NS, invoiceOptionsForPatient, openSalesInvoice } from "@/lib/sales/invoice";

export const dynamic = "force-dynamic";

const CODE_RE = /^[A-Za-z0-9_-]{1,16}$/;
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
    clinicCode: z.string().regex(CODE_RE).nullish(),
    patientApricotId: z.string().min(1).max(64),
    practitionerExtId: z.string().min(1).max(64),
    lines: z.array(lineSchema).min(1).max(30),
    payment: z.object({ amt: z.number().min(0).max(10_000_000), methodExtId: z.string().min(1).max(64) }).nullish(),
  })
  .strict();

function err(e: unknown) {
  if (e instanceof SalesActionError) {
    return NextResponse.json({ error: e.code, message: e.message, ...(e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {}) }, { status: e.status });
  }
  throw e;
}

export const GET = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  const pid = req.nextUrl.searchParams.get("patientApricotId") ?? "";
  const code = req.nextUrl.searchParams.get("clinicCode");
  if (!pid || pid.length > 64 || (code !== null && !CODE_RE.test(code))) return NextResponse.json({ error: "bad_request", message: "資料唔齊" }, { status: 400 });
  const direct = await recallSearchHit(auth.staff.id, DIRECT_SEARCH_NS, pid);
  if (!direct) return NextResponse.json({ error: "PATIENT_NOT_SEARCHED", message: "請重新搜尋病人" }, { status: 404 });
  try {
    return NextResponse.json(await invoiceOptionsForPatient(auth.staff.id, direct, { scope: scopedClinicSet(auth), clinicCode: code }));
  } catch (e) {
    return err(e);
  }
});

export const POST = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  assertCanWriteConversation(auth);
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "開單資料唔齊" }, { status: 400 });
  const b = parsed.data;
  const direct = await recallSearchHit(auth.staff.id, DIRECT_SEARCH_NS, b.patientApricotId);
  if (!direct) return NextResponse.json({ error: "PATIENT_NOT_SEARCHED", message: "請重新搜尋病人先開單" }, { status: 404 });
  try {
    const invoice = await openSalesInvoice({
      conversationId: null,
      direct,
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
  } catch (e) {
    return err(e);
  }
});
