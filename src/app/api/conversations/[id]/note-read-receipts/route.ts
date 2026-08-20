import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/conversations/[id]/note-read-receipts — 該對話所有 INTERNAL note 嘅已讀回執（H2）。
 *
 * 用途：UI 開對話時一次性攞齊 tick 狀態（同 GET messages 平級嘅 metadata 拉取）；
 * 之後靠 socket note:read 增量更新（唔 poll）。
 *
 * 回傳 { receipts: [{ messageId, staffId, readAt }] } — 零內文（note 內容喺 GET messages，
 * 呢度只有回執元數據）。
 *
 * RBAC：assertClinicAccess（STAFF 別店 → 403）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;

  const conv = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true, clinicId: true },
  });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, conv.clinicId); // STAFF 別店 → 403

  // 只撈 INTERNAL note 嘅回執（先攞 note id 陣列，再 join 回執 row）
  const noteRows = await prisma.message.findMany({
    where: { conversationId: id, channel: "INTERNAL" },
    select: { id: true },
  });
  const rows = await prisma.noteReadReceipt.findMany({
    where: { messageId: { in: noteRows.map((m) => m.id) } },
    select: { messageId: true, staffId: true, readAt: true },
    orderBy: { readAt: "asc" },
  });

  return NextResponse.json({
    receipts: rows.map((r) => ({ messageId: r.messageId, staffId: r.staffId, readAt: r.readAt.toISOString() })),
  });
});
