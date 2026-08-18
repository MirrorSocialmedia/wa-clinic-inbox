import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { publishNotify } from "@/lib/notify";

/**
 * GET /api/conversations/[id] — 單個對話（+ contact）。別店 → 403。
 * PATCH /api/conversations/[id] — 狀態轉換 / assignee / markRead。
 *   { status?: OPEN|PENDING|RESOLVED, assigneeId?: string|null, markRead?: boolean }
 *   markRead=true → unreadCount=0（打開對話時調）
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  status: z.enum(["OPEN", "PENDING", "RESOLVED"]).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  markRead: z.boolean().optional(),
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

  const { status, assigneeId, markRead } = parsed.data;

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
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(markRead === true ? { unreadCount: 0 } : {}),
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
    unreadCount: updated.unreadCount,
  });

  return NextResponse.json(updated);
});
