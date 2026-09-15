import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchVisitNote, WorkforceApiError } from "@/lib/workforce/client";
import { resolveConversationPatient } from "@/lib/patient-record";

/**
 * GET /api/conversations/[id]/patient-record/note?visitId= — 臨床全文（followup-v2 §2.4/§3.3）
 *
 * 🔴🔴 audit 紅線：CWM 側每次成功回傳**之前** 100% 落 EXTERNAL_NOTE_VIEWED
 *   （staffId + visitId，零內容）— W 只傳 X-Staff-Id（opaque = StaffUser.id）。
 *   W 側唔再記一份內容 audit（鐵律 3：臨床全文存 workforce；wa-inbox 唔存、唔 cache）。
 *
 * RBAC：requireAuth + assertConversationAccess（同 parent 路由口徑）。
 * visitId 屬唔屬於呢個病人由 CWM 端核對（row.patientApricotId mismatch → 404 VISIT_NOT_FOUND）。
 *
 * 無 cache：每手展開都係一新 call（收埋再展開 = 再 audit — §3.3 拍板 b）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const VISIT_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

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

  const visitId = new URL(req.url).searchParams.get("visitId") ?? "";
  if (!VISIT_ID_RE.test(visitId)) return NextResponse.json({ error: "bad visitId" }, { status: 400 });

  const resolved = await resolveConversationPatient({
    pinnedPatientApricotId: conv.pinnedPatientApricotId,
    waId: contact.waId,
    clinicCode: clinic.code,
  });
  if (!resolved) return NextResponse.json({ error: "no patient" }, { status: 404 });

  try {
    const note = await fetchVisitNote(resolved.patientApricotId, visitId, auth.staff.id);
    return NextResponse.json({ v: 1, visitId: note.visitId, visitDate: note.visitDate, noteKind: note.noteKind, note: note.note });
  } catch (e) {
    if (e instanceof WorkforceApiError) {
      if (e.status === 404) return NextResponse.json({ error: "not found" }, { status: 404 });
      // 429/503/網絡斷 → 502（UI 可重試）— 唔扮成功、唔洩內容
      log.warn(
        { conversationId: conv.id, clinic: clinic.code, err: e.status === 0 ? "network" : `status=${e.status}` },
        "patient-record: note fetch failed"
      );
      return NextResponse.json({ error: "workforce unavailable" }, { status: 502 });
    }
    throw e;
  }
});
