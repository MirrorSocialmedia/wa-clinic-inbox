import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { publishConvEvent, convRef } from "@/lib/notify";
import { RELATIONS } from "@/lib/patient-links";

/**
 * ★ cwi-multi-patient-20261018：單一電話 ↔ 病人連結
 * PATCH  — 改關係 body { relation }
 * DELETE — 移除（所有員工 — 擁有人拍板）；呢個電話啲對話如果釘住佢 → 一併取消釘住
 * AuditLog：PATIENT_LINK_UPDATE／PATIENT_LINK_REMOVE（meta 零 PII）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; patientApricotId: string }> };

const patchSchema = z.object({ relation: z.enum(RELATIONS).nullable() }).strict();

async function load(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  const { id, patientApricotId } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  assertCanWriteConversation(auth);
  const pid = decodeURIComponent(patientApricotId);
  const link = await prisma.contactPatientLink.findUnique({
    where: { contactId_patientApricotId: { contactId: conv.contactId, patientApricotId: pid } },
  });
  if (!link) return NextResponse.json({ error: "link not found" }, { status: 404 });
  return { auth, conv, link };
}

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const r = await load(req, ctx);
  if (r instanceof NextResponse) return r;
  await prisma.contactPatientLink.update({ where: { id: r.link.id }, data: { relation: parsed.data.relation } });
  await prisma.auditLog
    .create({
      data: {
        staffId: r.auth.staff.id,
        action: "PATIENT_LINK_UPDATE",
        entity: "Contact",
        entityId: r.conv.contactId,
        meta: { patientApricotId: r.link.patientApricotId, relation: parsed.data.relation },
      },
    })
    .catch(() => undefined);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const r = await load(req, ctx);
  if (r instanceof NextResponse) return r;
  await prisma.contactPatientLink.delete({ where: { id: r.link.id } });
  // 呢個電話嘅對話如果釘住佢 → 取消釘住（唔留低指向已移除病人嘅「目前病人」）
  const pinnedConvs = await prisma.conversation.findMany({
    where: { contactId: r.conv.contactId, pinnedPatientApricotId: r.link.patientApricotId },
  });
  for (const c of pinnedConvs) {
    await prisma.conversation.update({ where: { id: c.id }, data: { pinnedPatientApricotId: null, pinnedPatientName: null, pinnedPhoneHash: null } });
    await publishConvEvent(convRef(c), "patient:pinned", { conversationId: c.id, clinicId: c.clinicId, pinnedPatientApricotId: null });
  }
  await prisma.auditLog
    .create({
      data: {
        staffId: r.auth.staff.id,
        action: "PATIENT_LINK_REMOVE",
        entity: "Contact",
        entityId: r.conv.contactId,
        meta: { patientApricotId: r.link.patientApricotId, unpinnedConversations: pinnedConvs.length },
      },
    })
    .catch(() => undefined);
  return NextResponse.json({ ok: true });
});
