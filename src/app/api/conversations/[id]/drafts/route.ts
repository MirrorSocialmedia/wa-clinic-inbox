import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { DRAFT_STACK_MAX } from "@/lib/ai/draft-stack";

/**
 * GET /api/conversations/[id]/drafts — 對話嘅 pending AI 草稿（PROPOSED，最近 3 個（D-6））。
 *
 * UI 用法：切換/打開對話時 load；而後靠 Socket `draft:ready` / `draft:expired` 實時補。
 * 別店 → 403（assertConversationAccess，fail-closed）。
 * ★ cwi-final S1-13（D-6）：`stale` = 呢個草稿之後病人再講咗嘢（唔係回覆最新嗰句）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);

  const [drafts, latestIn] = await Promise.all([
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
  ]);
  // stale = 呢個草稿之後病人再講咗嘢（唔係回覆最新嗰句）
  return NextResponse.json({ drafts: drafts.map((d) => ({ ...d, stale: latestIn ? d.inReplyToMessageId !== latestIn.id : false })) });
});
