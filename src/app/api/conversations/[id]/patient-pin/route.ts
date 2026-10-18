import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { publishConvEvent, convRef } from "@/lib/notify";
import { phoneHash } from "@/lib/phone-hash";
import { lookupPatient, WorkforceApiError } from "@/lib/workforce/client";
import { upsertPatientLink, setConversationPatient } from "@/lib/patient-links";

/**
 * POST /api/conversations/[id]/patient-pin — 釘住舊客（booking-ui MD §1 A）
 *   body: { patientApricotId, patientName }
 *   驗證：server 端重算 phoneHash(contact.waId) + 重打 lookup → 提交嘅 patientApricotId 必喺 matches 入面
 *   （防 staff 手改 body 釘唔存在/唔屬呢個 contact 嘅病人）。
 *   AuditLog：PATIENT_PIN（meta 零 PII — 只 patientApricotId）。
 * DELETE — 取消釘住（MD 之外嘅小擴展：釘錯咗嘅解鎖；meta 零 PII）
 *
 * 權限：同店 staff（讀級）— 釘住唔發 WhatsApp 訊息，唔觸 Send Lock。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const pinSchema = z
  .object({
    patientApricotId: z.string().min(1),
    patientName: z.string().min(1),
  })
  .strict();

async function loadConvAndContact(id: string) {
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return null;
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  return { conv, contact };
}

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const parsed = pinSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const loaded = await loadConvAndContact(id);
  if (!loaded) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { conv, contact } = loaded;
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  assertCanWriteConversation(auth); // ★ cwi-final S3-3：SUPERVISOR 覆客 403（釘病人 = 改病人資料）

  // ★ cwi-multi-patient-20261018：已加入呢個電話嘅病人（家人 — 可能冇呢個電話）直接准釘；否則照舊核對電話配對
  const link = await prisma.contactPatientLink.findUnique({
    where: { contactId_patientApricotId: { contactId: contact.id, patientApricotId: parsed.data.patientApricotId } },
  });
  let match: { patientApricotId: string; patientName: string; patientCode?: string | null } | null = link
    ? { patientApricotId: link.patientApricotId, patientName: link.patientName ?? parsed.data.patientName, patientCode: link.patientCode }
    : null;
  if (!match) {
    let matches;
    try {
      // ★ cwi-apricotty-20261001：帶店碼（sameAccount）— 跨帳號照准釘（睇記錄 OK），落單先擋（confirm-core）
      const pinClinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId }, select: { code: true } });
      matches = (await lookupPatient(phoneHash(contact.waId), pinClinic?.code ?? null)).matches;
    } catch (e) {
      log.warn(
        { conversationId: conv.id, err: e instanceof WorkforceApiError ? `status=${e.status}` : e instanceof Error ? e.name : "unknown" },
        "patient-pin: lookup fail"
      );
      return NextResponse.json({ error: "patient lookup unavailable (workforce offline) — 稍後重試" }, { status: 502 });
    }
    match = matches.find((m) => m.patientApricotId === parsed.data.patientApricotId) ?? null;
    if (!match) {
      return NextResponse.json({ error: "patient not in lookup matches for this contact" }, { status: 400 });
    }
    // 釘住 = 確認呢個電話屬呢位病人 → 一併加入電話 ↔ 病人連結
    await upsertPatientLink({
      contactId: contact.id,
      patientApricotId: match.patientApricotId,
      patientCode: match.patientCode ?? null,
      patientName: match.patientName,
      source: "LOOKUP",
      staffId: auth.staff.id,
    });
  }

  // ★ cwi-final S2-8（B-9 性別預設 — 留 hook）：pin 成功時若 Contact.salutation 為空 → 用 lookup 回嚟嘅 gender 設
  //   ⏳ 前提未就緒：workforce patient-lookup 要 S5-13 先回 gender — 而家 matches[] 無 gender 欄 → 跳過。
  await setConversationPatient(conv, contact.waId, { patientApricotId: match.patientApricotId, patientName: match.patientName }, auth.staff.id);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const loaded = await loadConvAndContact(id);
  if (!loaded) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { conv } = loaded;
  await assertConversationAccess(auth, conv);
  assertCanWriteConversation(auth); // ★ cwi-final S3-3：SUPERVISOR 覆客 403（取消釘 = 改病人資料）

  if (conv.pinnedPatientApricotId) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { pinnedPatientApricotId: null, pinnedPatientName: null, pinnedPhoneHash: null },
    });
    await prisma.auditLog
      .create({
        data: {
          staffId: auth.staff.id,
          action: "PATIENT_UNPIN",
          entity: "Conversation",
          entityId: conv.id,
          meta: { clinicId: conv.clinicId },
        },
      })
      .catch(() => undefined);
    // ★ cwi-final S1-7：取消釘住 = 同一事件，pinnedPatientApricotId: null
    await publishConvEvent(convRef(conv), "patient:pinned", {
      conversationId: conv.id,
      clinicId: conv.clinicId,
      pinnedPatientApricotId: null,
    });
  }
  return NextResponse.json({ ok: true });
});
