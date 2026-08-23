import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { publishNotify } from "@/lib/notify";
import { assertCanAssign } from "@/lib/assign";

/**
 * GET /api/conversations/[id] — 單個對話（+ contact；conversation 含 AI 欄位 intent/urgency/urgent/aiSummary）。別店 → 403。
 * PATCH /api/conversations/[id] — 狀態轉換 / assignee / markRead / urgent。
 *   { status?: OPEN|PENDING|RESOLVED, assigneeId?: string|null, markRead?: boolean, urgent?: boolean }
 *   markRead=true → unreadCount=0（打開對話時調）
 *   urgent=false → 人工清急症紅標（true 由 AI worker 置；staff 唔可以手動標 false 假急症）
 *   status→RESOLVED → 自動清 urgent（急症已處理）
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  status: z.enum(["OPEN", "PENDING", "RESOLVED"]).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  markRead: z.boolean().optional(),
  urgent: z.literal(false).optional(), // 只准清（AI 嘅紅標 staff 唔可以手動加重）
});

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, conv.clinicId);
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  return NextResponse.json({ conversation: conv, contact });
});

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, conv.clinicId);

  // ★ H1：assignee 改動受權限模型約束（現任 assignee / ADMIN / unassigned claim / 接手 self；否則 403）
  if (parsed.data.assigneeId !== undefined) {
    assertCanAssign(auth, conv, parsed.data.assigneeId);
  }

  const { status, assigneeId, markRead, urgent } = parsed.data;

  // assignee 必須係同店嘅 staff（STAFF 唔會見到別店 staff；ADMIN 都可以指定）
  if (assigneeId) {
    const staff = await prisma.staffUser.findUnique({ where: { id: assigneeId } });
    if (!staff || !staff.active) {
      return NextResponse.json({ error: "assignee not found or inactive" }, { status: 400 });
    }
    // STAFF 做嘅 assignee 必須同店；ADMIN 做嘅可以跨店（ADMIN 嘅對話都在任何店）
    if (staff.clinicId && staff.clinicId !== conv.clinicId) {
      return NextResponse.json({ error: "assignee belongs to another clinic" }, { status: 400 });
    }
  }

  const updated = await prisma.conversation.update({
    where: { id },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(assigneeId !== undefined
        ? {
            assigneeId,
            // ★ Realtime P0 (R5)：assignee 變動必 assignVersion+1（同 assign.ts 不變式 —
            //   人手 assign 用 version 樂觀鎖，呢度直接改 assignee 都要推版本）
            assignVersion: { increment: 1 },
          }
        : {}),
      ...(markRead === true ? { unreadCount: 0 } : {}),
      // 急症紅標：status→RESOLVED 自動清；urgent=false 手動清；唔會由呢度設 true
      ...(status === "RESOLVED" || urgent === false ? { urgent: false } : {}),
    },
  });

  log.info(
    {
      conversationId: id,
      clinicId: conv.clinicId,
      staffId: auth.staff.id,
      status: status ?? null,
      assigneeId: assigneeId === null ? "cleared" : assigneeId ?? null,
      markRead,
    },
    "conversation updated"
  );

  publishNotify(conv.clinicId, "conv:updated", {
    conversationId: updated.id,
    clinicId: conv.clinicId,
    status: updated.status,
    assigneeId: updated.assigneeId,
    // ★ R5：新 version — 其他 client 同步（之後 assign 先唔會 409）
    assignVersion: updated.assignVersion,
    unreadCount: updated.unreadCount,
  });

  return NextResponse.json(updated);
});
