import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { publishNotify, publishStaffNotify } from "@/lib/notify";

/**
 * POST /api/conversations/[id]/app-handoff — cwi-window-20260901（P3 / W-1）
 *
 * 過窗三出路 ①「開手機對話」撳掣後端：
 *   1. audit APP_HANDOFF_CLICK（零 PII 鐵律：只記 conversationId + staffId — **絕不記電話原文**）
 *   2. 一條 INTERNAL 備註「已轉用手機 App 跟進」（同店同事知道唔好重複覆）
 *
 * 手機端 wa.me deep link 由 client 自己拼（E164 無加號 + encodeURIComponent 草稿）— server 唔經手電話。
 * 無 Send Lock 檢查（同 INTERNAL note route — 備註性質，唔係覆病人）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(auth, conv); // STAFF 別店 → 403

  // 1) audit：APP_HANDOFF_CLICK（metadata only — 零電話/零內文）
  await prisma.auditLog.create({
    data: {
      staffId: auth.staff.id,
      action: "APP_HANDOFF_CLICK",
      entity: "Conversation",
      entityId: conv.id,
      meta: { conversationId: conv.id },
    },
  });
  log.info(
    { clinicId: conv.clinicId, conversationId: conv.id, staffId: auth.staff.id },
    "app-handoff: APP_HANDOFF_CLICK（metadata only — 零 PII）"
  );

  // 2) INTERNAL 備註（留痕 — 其他同事唔好重複覆；assignee 唔係自己 → mention 佢）
  const now = new Date();
  const msg = await prisma.message.create({
    data: {
      conversationId: conv.id,
      direction: "OUT",
      channel: "INTERNAL",
      type: "note",
      body: "已轉用手機 App 跟進（wa.me 開對話）— 其他同事唔好重複覆",
      status: "SENT",
      waMessageId: null, // INTERNAL 永唔出 Graph API
      sentByStaffId: auth.staff.id,
      mentions: conv.assigneeId && conv.assigneeId !== auth.staff.id ? [conv.assigneeId] : [],
      billingCategory: "NONE", // cwi-window-20260901（P1）：INTERNAL 備註唔計費
      waTimestamp: now,
    },
  });

  // touch lastMessageAt（唔加 unreadCount — 病人冇新訊息）
  await prisma.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;

  // socket：同店 note:new（client 重拉訊息 — 備註即時見）+ 被 mention 者定向通知
  publishNotify(conv.clinicId, "note:new", {
    conversationId: conv.id,
    clinicId: conv.clinicId,
    messageId: msg.id,
  });
  for (const sid of msg.mentions ?? []) {
    if (sid === auth.staff.id) continue;
    publishStaffNotify(sid, conv.clinicId, "notify:mention", {
      conversationId: conv.id,
      clinicId: conv.clinicId,
      messageId: msg.id,
      fromStaffId: auth.staff.id,
    });
  }

  return NextResponse.json({ ok: true, noteId: msg.id });
});
