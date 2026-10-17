import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess, assertCanWriteConversation, RbacError } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { assignConversation } from "@/lib/assign";
import { publishConvEvent, convRef } from "@/lib/notify";

/**
 * ★ cwi-inbox-r3 Q5（2026-10-17）：POST /api/conversations/[id]/location — 轉地點（跟進分店）。
 *
 * body: { toClinicId: string, reason?: string (≤200), assignToStaffId?: string | null }
 *
 * 語義：
 * - WhatsApp 對話一定跟住病人搵嘅號碼（clinicId 唔變 — 收發照用原號碼）；轉嘅係「由邊間分店跟進」
 *   （Conversation.handlingClinicId）。轉返原店 = 清返 null。
 * - 列表／公海／權限／通知／預約預設跟新地點（rbac locationIn / notify / push）。
 * - 負責人：預設清空 → 回新分店公海；assignToStaffId 有值 → 直接指派（任何 active staff）。
 * - 留痕：INTERNAL 備註「📍 地點由 A 轉到 B（原因）」+ AuditLog LOCATION_TRANSFER。
 *
 * 權限（擁有人拍板 2026-10-17）：
 * - 現任負責人 ∨ ADMIN（SUPERVISOR 唯讀 → 403）；actor 要開得到呢個對話。
 * - 目標分店唔限 actor 自己有冇權限；但必須同號碼店**同一間公司**（SaaS 租戶隔離 — 唔准跨公司）。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const schema = z.object({
  toClinicId: z.string().min(1).max(64),
  reason: z.string().trim().max(200).optional(),
  assignToStaffId: z.string().min(1).max(64).nullable().optional(),
});

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  assertCanWriteConversation(auth); // SUPERVISOR 唯讀
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const { toClinicId, reason, assignToStaffId } = parsed.data;

  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  if (auth.staff.role !== "ADMIN" && conv.assigneeId !== auth.staff.id) {
    throw new RbacError(403, "only the current assignee or an admin can change location");
  }

  const [channelClinic, target] = await Promise.all([
    prisma.clinic.findUnique({ where: { id: conv.clinicId }, select: { id: true, code: true, name: true, companyId: true } }),
    prisma.clinic.findUnique({ where: { id: toClinicId }, select: { id: true, code: true, name: true, companyId: true } }),
  ]);
  if (!channelClinic || !target) return NextResponse.json({ error: "clinic not found", code: "CLINIC_NOT_FOUND" }, { status: 404 });
  if ((target.companyId ?? null) !== (channelClinic.companyId ?? null)) {
    return NextResponse.json(
      { error: "只可以轉去同一間公司嘅分店", code: "CROSS_COMPANY_FORBIDDEN" },
      { status: 403 }
    );
  }
  const fromId = conv.handlingClinicId ?? conv.clinicId;
  if (fromId === target.id) return NextResponse.json({ error: "已經喺呢個地點", code: "SAME_LOCATION" }, { status: 400 });

  if (assignToStaffId) {
    const s = await prisma.staffUser.findUnique({ where: { id: assignToStaffId }, select: { active: true } });
    if (!s?.active) return NextResponse.json({ error: "staff not found or inactive", code: "BAD_ASSIGNEE" }, { status: 400 });
  }

  const fromClinic =
    fromId === channelClinic.id ? channelClinic : await prisma.clinic.findUnique({ where: { id: fromId }, select: { code: true, name: true } });
  const newHandling = target.id === conv.clinicId ? null : target.id;

  // 樂觀鎖：handlingClinicId 未被第二個人改過先寫（並發轉地點 → 後到者 409）
  const upd = await prisma.conversation.updateMany({
    where: { id: conv.id, handlingClinicId: conv.handlingClinicId },
    data: { handlingClinicId: newHandling },
  });
  if (upd.count === 0) return NextResponse.json({ error: "地點啱啱俾其他同事改咗 — 請重新整理", code: "LOCATION_CONFLICT" }, { status: 409 });

  const noteText = `📍 地點由 ${fromClinic?.code ?? "?"} 轉到 ${target.code}${reason ? `（${reason}）` : ""}`;

  // 負責人：指派指定同事 ／ 有負責人就放返新分店公海 ／ 本身未指派就只落備註
  let assigneeId: string | null = conv.assigneeId;
  let assignVersion = conv.assignVersion;
  if (assignToStaffId && assignToStaffId !== conv.assigneeId) {
    const r = await assignConversation({ conversationId: conv.id, toStaffId: assignToStaffId, by: "STAFF", byStaffId: auth.staff.id, note: noteText });
    assigneeId = r.assigneeId;
    assignVersion = r.assignVersion;
  } else if (!assignToStaffId && conv.assigneeId) {
    const r = await assignConversation({ conversationId: conv.id, toStaffId: null, by: "STAFF", byStaffId: auth.staff.id, note: noteText });
    assigneeId = r.assigneeId;
    assignVersion = r.assignVersion;
  } else {
    const now = new Date();
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "INTERNAL",
        type: "note",
        body: noteText,
        status: "SENT",
        waMessageId: null,
        sentByStaffId: auth.staff.id,
        mentions: [],
        billingCategory: "NONE",
        waTimestamp: now,
      },
    });
    await prisma.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;
    await publishConvEvent(convRef({ ...conv, handlingClinicId: newHandling }), "note:new", {
      conversationId: conv.id,
      clinicId: conv.clinicId,
      messageId: msg.id,
    });
  }

  await prisma.auditLog.create({
    data: {
      staffId: auth.staff.id,
      action: "LOCATION_TRANSFER",
      entity: "Conversation",
      entityId: conv.id,
      meta: {
        channelClinicId: conv.clinicId,
        fromClinicId: fromId,
        toClinicId: target.id,
        assignToStaffId: assignToStaffId ?? null,
        hasReason: !!reason,
      } as object,
    },
  });

  // 新舊兩個地點 room 都要知（publishConvEvent 用新 handling 發去新 room + 號碼店 room；舊跟進分店另補）
  const payload = {
    conversationId: conv.id,
    clinicId: conv.clinicId,
    assigneeId,
    assignVersion,
    handlingClinicId: newHandling,
    locationClinicId: target.id,
    locationCode: target.code,
    locationName: target.name,
    locationChanged: true,
  };
  await publishConvEvent(convRef({ ...conv, assigneeId, handlingClinicId: newHandling }), "conv:updated", payload);
  if (conv.handlingClinicId && conv.handlingClinicId !== target.id) {
    await publishConvEvent(convRef({ ...conv, assigneeId, handlingClinicId: conv.handlingClinicId }), "conv:updated", payload);
  }

  log.info(
    { conversationId: conv.id, staffId: auth.staff.id, from: fromId, to: target.id, assigned: !!assignToStaffId },
    "conversation: location transferred"
  );

  return NextResponse.json({
    ok: true,
    conversationId: conv.id,
    handlingClinicId: newHandling,
    locationClinicId: target.id,
    locationCode: target.code,
    locationName: target.name,
    assigneeId,
    assignVersion,
  });
});
