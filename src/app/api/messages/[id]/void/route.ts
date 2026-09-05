import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { publishNotify } from "@/lib/notify";

/**
 * POST /api/messages/[id]/void — 「標記為已作廢」（cwi-inboxfix-20260905，MD §5.3）。
 *
 * 語義（MD §5.3）：8 秒撤回窗口過咗之後，訊息已經發出（病人嗰邊照見 — WhatsApp Cloud API
 *   冇刪除已發訊息 endpoint），staff 可以將該 OUT 訊息標記為「已作廢」：
 *   - 純內部標記（Message.voidedAt = now）— 後續以更正訊息為準；
 *   - UI 氣泡加「已作廢」內部 tag（只 staff 端可見口徑；病人端 WhatsApp 照舊顯示原文）。
 *
 * 只收 OUT/API 已發出訊息（SENT/DELIVERED/READ — 即 waMessageId 已有）；冪等（重複標記 200）。
 * RBAC：assertConversationAccess + 發送者本人 ∨ ADMIN。
 * audit：MESSAGE_VOID（messageId + staffId）。
 * socket：message:status 帶 voidedAt（UI 即時加 tag；零內文）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;

  const msg = await prisma.message.findUnique({ where: { id } });
  if (!msg) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (msg.direction !== "OUT" || msg.channel !== "API") {
    return NextResponse.json({ error: "only outbound API messages can be voided" }, { status: 400 });
  }
  // 只可以標「已發出」嘅訊息（QUEUED/CANCELLED 冇意義 — 前者用 undo，後者已標記）
  if (!msg.waMessageId) {
    return NextResponse.json({ error: "message not sent yet — use undo within the 8s window" }, { status: 409 });
  }
  const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(auth, conv); // STAFF 別店 → 403

  if (msg.sentByStaffId && msg.sentByStaffId !== auth.staff.id && auth.staff.role !== "ADMIN") {
    return NextResponse.json({ error: "only the sender or an admin can void" }, { status: 403 });
  }

  // 冪等：已標記 → 200 回現有值（唔重開 audit — 避免風暴標記灌水 audit 表）
  if (msg.voidedAt) {
    return NextResponse.json({ ok: true, voidedAt: msg.voidedAt });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.message.update({ where: { id: msg.id }, data: { voidedAt: now } }),
    prisma.auditLog.create({
      data: {
        staffId: auth.staff.id,
        action: "MESSAGE_VOID",
        entity: "Message",
        entityId: msg.id,
        meta: { conversationId: conv.id, messageId: msg.id, staffId: auth.staff.id },
      },
    }),
  ]);

  publishNotify(conv.clinicId, "message:status", {
    conversationId: conv.id,
    clinicId: conv.clinicId,
    waMessageId: msg.id,
    status: msg.status,
    voidedAt: now.toISOString(),
  });

  log.info({ messageId: msg.id, conversationId: conv.id, staffId: auth.staff.id }, "void: message marked as voided (internal)");
  return NextResponse.json({ ok: true, voidedAt: now.toISOString() });
});
