import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { publishNotify } from "@/lib/notify";
import { phoneHash } from "@/lib/phone-hash";
import { lookupPatient, WorkforceApiError } from "@/lib/workforce/client";

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

function pinUpdatedPayload(clinicId: string, conversationId: string) {
  return { conversationId, clinicId, reason: "patient-pin" };
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
  assertConversationAccess(auth, conv);

  const hash = phoneHash(contact.waId);
  let matches;
  try {
    matches = (await lookupPatient(hash)).matches;
  } catch (e) {
    log.warn(
      { conversationId: conv.id, err: e instanceof WorkforceApiError ? `status=${e.status}` : e instanceof Error ? e.name : "unknown" },
      "patient-pin: lookup fail"
    );
    return NextResponse.json({ error: "patient lookup unavailable (workforce offline) — 稍後重試" }, { status: 502 });
  }
  const match = matches.find((m) => m.patientApricotId === parsed.data.patientApricotId);
  if (!match) {
    return NextResponse.json({ error: "patient not in lookup matches for this contact" }, { status: 400 });
  }

  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      pinnedPatientApricotId: match.patientApricotId,
      pinnedPatientName: match.patientName,
      pinnedPhoneHash: hash,
    },
  });

  await prisma.auditLog
    .create({
      data: {
        staffId: auth.staff.id,
        action: "PATIENT_PIN",
        entity: "Conversation",
        entityId: conv.id,
        meta: { patientApricotId: match.patientApricotId, clinicId: conv.clinicId },
      },
    })
    .catch(() => undefined);

  publishNotify(conv.clinicId, "conv:updated", pinUpdatedPayload(conv.clinicId, conv.id));
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const loaded = await loadConvAndContact(id);
  if (!loaded) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { conv } = loaded;
  assertConversationAccess(auth, conv);

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
    publishNotify(conv.clinicId, "conv:updated", pinUpdatedPayload(conv.clinicId, conv.id));
  }
  return NextResponse.json({ ok: true });
});
