import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { assignConversation, assertCanAssign, AssignError } from "@/lib/assign";

/**
 * POST /api/conversations/[id]/assign — 轉交 / 接手 / 放返隊列（MD §3.1）。
 *
 * body: { toStaffId: string | null, note?: string (1..2000), assignVersion?: number }
 *   - toStaffId = staffId → 轉交畀佢（自動生成 INTERNAL note，mentions=[toStaffId]）
 *   - toStaffId = self    → 接手（lock 翻轉；自動 note「{byName} 接手咗」）
 *   - toStaffId = null    → 放返隊列（unassign；自動 note）
 *   - ★ Realtime P0 (R5)：assignVersion = client 端持有嘅版本（list/GET 回傳）→ 樂觀鎖；
 *     陳舊 → 409 ASSIGN_CONFLICT（帶 currentAssigneeId/Name/assignVersion — UI 提示 + refetch）
 *
 * 權限（MD §3.1 + §3.2）：現任 assignee / ADMIN / unassigned claim / 接手（self-claim）。
 * 流程：單一 $transaction（見 src/lib/assign.ts）→ socket conversation:assigned。
 *
 * 錯誤：404 對話唔存在 / 403 無權 / 400 toStaffId 唔合法（唔存在/停用/別店）
 *       409 並發轉交 conflict（retry）/ 409 ASSIGN_CONFLICT（R5 版本陳舊）/ 400 body 校驗。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  toStaffId: z.string().min(1).nullable(),
  note: z.string().min(1).max(2000).optional(),
  // ★ Realtime P0 (R5)：client 端版本（樂觀鎖）— optional（舊 client / e2e 唔帶 → 舊 lock 語義）
  assignVersion: z.number().int().min(0).optional(),
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

  // ★ R5：client 帶 version → 樂觀鎖（陳舊 → ASSIGN_CONFLICT）；唔帶 → 舊 assigneeId lock
  let r;
  try {
    r = await assignConversation({
      conversationId: conv.id,
      toStaffId: parsed.data.toStaffId,
      by: "STAFF",
      byStaffId: auth.staff.id,
      note: parsed.data.note,
      expectedAssignVersion: parsed.data.assignVersion,
    });
  } catch (err) {
    // ★ R5：版本陳舊 → 409 ASSIGN_CONFLICT（帶最新負責人資料 — UI 顯示「啱啱俾 {name} 接咗手」+ refetch）
    if (err instanceof AssignError && err.code === "ASSIGN_CONFLICT") {
      const latest = await prisma.conversation.findUnique({
        where: { id: conv.id },
        select: { assigneeId: true, assignVersion: true },
      });
      const assignee = latest?.assigneeId
        ? await prisma.staffUser.findUnique({ where: { id: latest.assigneeId }, select: { name: true } })
        : null;
      return NextResponse.json(
        {
          error: "ASSIGN_CONFLICT",
          message: assignee ? `呢個對話啱啱俾 ${assignee.name} 接咗手 — 已更新列表` : "呢個對話分配剛改變 — 已更新列表",
          currentAssigneeId: latest?.assigneeId ?? null,
          currentAssigneeName: assignee?.name ?? null,
          assignVersion: latest?.assignVersion ?? null,
        },
        { status: 409 }
      );
    }
    throw err;
  }

  return NextResponse.json({
    ok: true,
    conversationId: r.conversationId,
    assigneeId: r.assigneeId,
    assignedAt: r.assignedAt,
    noteMessageId: r.noteMessageId,
    action: r.auditAction,
    // ★ Realtime P0 (R5)：新版本號 — client applyAssignResult 用（之後 assign 先唔會 409）
    assignVersion: r.assignVersion,
  });
});
