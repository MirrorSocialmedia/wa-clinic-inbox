import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { assignConversation, assertCanAssign } from "@/lib/assign";

/**
 * POST /api/conversations/[id]/assign — 轉交 / 接手 / 放返隊列（MD §3.1）。
 *
 * body: { toStaffId: string | null, note?: string (1..2000) }
 *   - toStaffId = staffId → 轉交畀佢（自動生成 INTERNAL note，mentions=[toStaffId]）
 *   - toStaffId = self    → 接手（lock 翻轉；自動 note「{byName} 接手咗」）
 *   - toStaffId = null    → 放返隊列（unassign；自動 note）
 *
 * 權限（MD §3.1 + §3.2）：現任 assignee / ADMIN / unassigned claim / 接手（self-claim）。
 * 流程：單一 $transaction（見 src/lib/assign.ts）→ socket conversation:assigned。
 *
 * 錯誤：404 對話唔存在 / 403 無權 / 400 toStaffId 唔合法（唔存在/停用/別店）
 *       409 並發轉交 conflict（retry）/ 400 body 校驗。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  toStaffId: z.string().min(1).nullable(),
  note: z.string().min(1).max(2000).optional(),
});

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, conv.clinicId); // STAFF 別店 → 403
  assertCanAssign(auth, conv, parsed.data.toStaffId); // 現任 assignee / ADMIN / unassigned claim / 接手（self）

  const r = await assignConversation({
    conversationId: conv.id,
    toStaffId: parsed.data.toStaffId,
    by: "STAFF",
    byStaffId: auth.staff.id,
    note: parsed.data.note,
  });

  return NextResponse.json({
    ok: true,
    conversationId: r.conversationId,
    assigneeId: r.assigneeId,
    assignedAt: r.assignedAt,
    noteMessageId: r.noteMessageId,
    action: r.auditAction,
  });
});
