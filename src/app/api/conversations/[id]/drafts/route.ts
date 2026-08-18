import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/conversations/[id]/drafts — 對話嘅 pending AI 草稿（PROPOSED，最新 5 條）。
 *
 * UI 用法：切換/打開對話時 load；而後靠 Socket `draft:ready` 實時補。
 * 別店 → 403（assertClinicAccess，fail-closed）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, conv.clinicId);

  const drafts = await prisma.aiDraft.findMany({
    where: { conversationId: id, status: "PROPOSED" },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return NextResponse.json({ drafts });
});
