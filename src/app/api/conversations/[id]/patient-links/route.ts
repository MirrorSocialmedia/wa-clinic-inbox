import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { phoneHash } from "@/lib/phone-hash";
import { lookupPatient, WorkforceApiError } from "@/lib/workforce/client";
import { RELATIONS, listPatientLinks, upsertPatientLink, recallSearchHit, setConversationPatient } from "@/lib/patient-links";

/**
 * ★ cwi-multi-patient-20261018：電話 ↔ 病人檔（一個電話連幾個家人）
 *
 * GET  — 呢個電話已加入嘅病人 + 對話目前病人
 * POST — 加入（可同時設為目前）：body { patientApricotId, relation?, setActive? }
 *   病人必須係 ① 電話配對清單入面（LOOKUP）或 ② 呢位 staff 15 分鐘內搜尋結果入面（SEARCH）— 唔信 client 傳嘅名／編號。
 *
 * 權限：讀 = 對話可見；寫 = 對話可寫（所有員工 — 擁有人拍板；SUPERVISOR 覆客唯讀）。
 * AuditLog：PATIENT_LINK_ADD（meta 零 PII — 只 patientApricotId／來源／關係）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const addSchema = z
  .object({
    patientApricotId: z.string().min(1).max(64),
    relation: z.enum(RELATIONS).nullable().optional(),
    setActive: z.boolean().optional(),
  })
  .strict();

async function loadConv(id: string) {
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return null;
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  return contact ? { conv, contact } : null;
}

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const loaded = await loadConv(id);
  if (!loaded) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, loaded.conv);
  const links = await listPatientLinks(loaded.contact.id);
  return NextResponse.json({
    links: links.map((l) => ({
      patientApricotId: l.patientApricotId,
      patientCode: l.patientCode,
      patientName: l.patientName,
      relation: l.relation,
      source: l.source,
      createdAt: l.createdAt.toISOString(),
    })),
    activePatientApricotId: loaded.conv.pinnedPatientApricotId,
  });
});

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const loaded = await loadConv(id);
  if (!loaded) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { conv, contact } = loaded;
  await assertConversationAccess(auth, conv);
  assertCanWriteConversation(auth);
  const pid = parsed.data.patientApricotId;

  // 來源核對：已加入 → 照准（改關係／設目前）；否則 搜尋結果 → 電話配對
  const existing = await prisma.contactPatientLink.findUnique({ where: { contactId_patientApricotId: { contactId: contact.id, patientApricotId: pid } } });
  let patient: { patientApricotId: string; patientCode: string | null; patientName: string | null } | null = existing
    ? { patientApricotId: pid, patientCode: existing.patientCode, patientName: existing.patientName }
    : null;
  let source: "LOOKUP" | "SEARCH" = "SEARCH";
  if (!patient) {
    const hit = await recallSearchHit(auth.staff.id, contact.id, pid);
    if (hit) patient = hit;
  }
  if (!patient) {
    try {
      const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId }, select: { code: true } });
      const m = (await lookupPatient(phoneHash(contact.waId), clinic?.code ?? null)).matches.find((x) => x.patientApricotId === pid);
      if (m) {
        patient = { patientApricotId: pid, patientCode: m.patientCode ?? null, patientName: m.patientName };
        source = "LOOKUP";
      }
    } catch (e) {
      log.warn(
        { conversationId: conv.id, err: e instanceof WorkforceApiError ? `status=${e.status}` : e instanceof Error ? e.name : "unknown" },
        "patient-links: lookup fail"
      );
    }
  }
  if (!patient) {
    return NextResponse.json({ error: "搵唔到呢個病人（請重新搜尋再加入）" }, { status: 400 });
  }

  await upsertPatientLink({
    contactId: contact.id,
    patientApricotId: pid,
    patientCode: patient.patientCode,
    patientName: patient.patientName,
    relation: parsed.data.relation ?? null,
    source,
    staffId: auth.staff.id,
  });
  if (!existing) {
    await prisma.auditLog
      .create({
        data: {
          staffId: auth.staff.id,
          action: "PATIENT_LINK_ADD",
          entity: "Contact",
          entityId: contact.id,
          meta: { patientApricotId: pid, source, relation: parsed.data.relation ?? null, conversationId: conv.id },
        },
      })
      .catch(() => undefined);
  }
  if (parsed.data.setActive) {
    await setConversationPatient(conv, contact.waId, { patientApricotId: pid, patientName: patient.patientName }, auth.staff.id);
  }
  return NextResponse.json({ ok: true });
});
