import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { DRAFT_STACK_MAX } from "@/lib/ai/draft-stack";
import { buildFollowupTaskViews } from "@/lib/followup/tasks-view";
import { toMessageDto } from "../messages/message-dto";

/**
 * GET /api/conversations/[id]/bundle — 開對話一次 round trip（cwi-final S6-7 前端效能）。
 *
 * 合併四個「開對話」平行 fetch 成一個（messages latest + drafts + note receipts + followup suggestion）—
 * 首屏 4 round trip → 1；每段 query 口徑與各自 route **逐字同源**（防兩處漂移）：
 * - messages = GET .../messages 無參數分支（最新一頁 50，createdAt desc + reverse，hasMore）
 * - drafts   = GET .../drafts（PROPOSED 堆疊 DRAFT_STACK_MAX + stale）
 * - receipts = GET .../note-read-receipts（INTERNAL note 已讀回執）
 * - suggestion = GET /api/followups/tasks?conversationId=&limit=1 口徑（buildFollowupTaskViews 共用）
 *
 * RBAC：assertConversationAccess（別店 STAFF → 403；SUPERVISOR 唯讀通行）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv);

  const [rows, drafts, latestIn, noteIds, suggestionTasks] = await Promise.all([
    // ── messages latest（同 GET .../messages 無參數分支：createdAt desc 攞 limit+1 → reverse）──
    prisma.message.findMany({
      where: { conversationId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    }),
    // ── drafts（同 GET .../drafts：PROPOSED 堆疊 + latest IN 算 stale）──
    prisma.aiDraft.findMany({
      where: { conversationId: id, status: "PROPOSED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DRAFT_STACK_MAX,
    }),
    prisma.message.findFirst({
      where: { conversationId: id, direction: "IN", channel: "API" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
    // ── receipts（同 GET .../note-read-receipts：只 INTERNAL note）──
    prisma.message.findMany({ where: { conversationId: id, channel: "INTERNAL" }, select: { id: true } }),
    // ── suggestion（同 followups/tasks?conversationId=&limit=1 口徑）──
    buildFollowupTaskViews({ status: "SUGGESTED", conversationId: id, clinicSet: scopedClinicSet(ctx), limit: 1 }),
  ]);

  const hasMore = rows.length > 50;
  const page = hasMore ? rows.slice(0, 50) : rows;
  // ★ cwi-qa FX-24（QA-24）：同 messages route 同一 DTO（../messages/message-dto.ts）—
  //   剷 waMediaId + mediaPath 絕對路徑 → /api/media/<mediaKey>（防 bundle 漏絕對路徑/waMediaId）。
  const messages = [...page].reverse().map(toMessageDto);
  const receipts = noteIds.length
    ? (await prisma.noteReadReceipt.findMany({
        where: { messageId: { in: noteIds.map((m) => m.id) } },
        select: { messageId: true, staffId: true, readAt: true },
        orderBy: { readAt: "asc" },
      })).map((r) => ({ messageId: r.messageId, staffId: r.staffId, readAt: r.readAt.toISOString() }))
    : [];

  return NextResponse.json({
    messages,
    hasMore,
    oldest: messages[0] ?? null,
    newest: messages[messages.length - 1] ?? null,
    // stale = 呢個草稿之後病人再講咗嘢（同 GET .../drafts 口徑）
    drafts: drafts.map((d) => ({ ...d, stale: latestIn ? d.inReplyToMessageId !== latestIn.id : false })),
    receipts,
    suggestion: suggestionTasks[0] ?? null,
  });
});
