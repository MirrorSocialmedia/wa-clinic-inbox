import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/conversations/[id]/messages — 對話訊息分頁（MD §6.4）。
 *
 * 參數：
 * - before=<ISO/epochMs>  向上捲：waTimestamp < before（旧嘅），升序回傳
 * - after=<ISO/epochMs>   reconnect 補漏：waTimestamp > after，升序回傳
 * - （都唔給）            初始載入：最新 N 條，升序回傳
 * - limit  預設 50（MD：分頁 50 條/頁），上限 100
 *
 * 回傳 { messages, hasMore, oldest, newest } — UI 用 oldest 做「再向上」cursor。
 * HISTORY 段自然喺最舊（waTimestamp 係歷史時間）— 同新訊息同一條 timeline。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function parseTs(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(auth, conv);

  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const before = parseTs(url.searchParams.get("before"));
  const after = parseTs(url.searchParams.get("after"));

  const where: Record<string, unknown> = { conversationId: id };
  if (before) where.waTimestamp = { lt: before };
  if (after) where.waTimestamp = { gt: after };

  // 多取 1 條判定 hasMore；同 timestamp 用 id 做次級排序（batch history 冪等穩定）
  const rows = before
    ? await prisma.message.findMany({
        where,
        orderBy: [{ waTimestamp: "desc" }, { id: "desc" }],
        take: limit + 1,
      })
    : await prisma.message.findMany({
        where,
        orderBy: [{ waTimestamp: "asc" }, { id: "asc" }],
        take: limit + 1,
      });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const messages = before ? [...page].reverse() : page;

  return NextResponse.json({
    messages,
    hasMore,
    oldest: messages[0] ?? null,
    newest: messages[messages.length - 1] ?? null,
  });
});
