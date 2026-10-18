import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchPatientConsultations, WorkforceApiError } from "@/lib/workforce/client";
import { resolveConversationPatient } from "@/lib/patient-record";

/**
 * GET /api/conversations/[id]/patient-record/consultations?page=N — 診症及處方歷史（cwi-consult-history-20261018）
 *
 * 擁有人拍板：病歷要齊全部記錄 — CWM 直接逐頁問 Apricot（每頁 8 筆，新→舊；唔經到診索引）。
 * 🔴 audit：CWM 側每頁回傳前落 EXTERNAL_CONSULTATIONS_VIEWED（staffId + 病人 + 頁，零內容）。
 *   wa-inbox 唔存、唔 cache 臨床全文（鐵律 3）。
 * 病人 = 對話目前病人（釘住 → 電話判定 → 預約配對；同病人記錄同一套）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });
  const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId }, select: { code: true } });
  if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 500 });

  const page = Number(new URL(req.url).searchParams.get("page") ?? "0");
  if (!Number.isInteger(page) || page < 0 || page > 100) return NextResponse.json({ error: "bad page" }, { status: 400 });

  const resolved = await resolveConversationPatient({
    pinnedPatientApricotId: conv.pinnedPatientApricotId,
    identifiedPatientApricotId: contact.identifiedPatientApricotId,
    waId: contact.waId,
    clinicCode: clinic.code,
  });
  if (!resolved) return NextResponse.json({ v: 1, page, hasMore: false, consultations: [], patient: null });

  try {
    const r = await fetchPatientConsultations(resolved.patientApricotId, page, auth.staff.id);
    return NextResponse.json({ ...r, patient: { patientApricotId: resolved.patientApricotId } });
  } catch (e) {
    if (e instanceof WorkforceApiError) {
      log.warn(
        { conversationId: conv.id, clinic: clinic.code, page, err: e.status === 0 ? "network" : `status=${e.status}` },
        "patient-record: consultations fetch failed"
      );
      // 503 = Apricot 斷；其餘（網絡／舊版 CWM 冇呢條路 404）→ 502 — UI 可重試，唔扮成功
      return NextResponse.json({ error: e.status === 503 ? "apricot unavailable" : "workforce unavailable" }, { status: e.status === 503 ? 503 : 502 });
    }
    throw e;
  }
});
