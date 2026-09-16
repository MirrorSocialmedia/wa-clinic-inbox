import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { sendFollowupTask } from "@/lib/followup/engine";

/**
 * ★ cwi-followup-p3-20260916（MD §4.7 驗收 #5：L1 隊列人撳發送）：
 *
 * POST /api/followups/tasks/:id  body { action: "send" | "cancel" }
 *   send   → L1 人撳發送（sentVia = AI_ADOPTED — 唔觸發 human cooldown；鐵律 2）
 *            行 sendFollowupTask()：發送前取消檢查重跑（MD §4.4）→ QUEUED → outbound worker。
 *   cancel → 人手取消（cancelReason = MANUAL）。
 *   權限：staff+（clinic scope 內）；零 claim（assigneeId 唔改 — 鐵律 5）。
 *   回：{ ok, result: { status, cancelReason?, messageId?, viaTemplate? } }
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  const action = body?.action;
  if (action !== "send" && action !== "cancel") {
    return NextResponse.json({ error: "action = send | cancel" }, { status: 400 });
  }
  const task = await prisma.followupTask.findUnique({ where: { id } });
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const clinicSet = scopedClinicSet(ctx);
  if (clinicSet && !clinicSet.includes(task.clinicId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (action === "cancel") {
    if (task.status !== "SCHEDULED" && task.status !== "DUE") {
      return NextResponse.json({ error: `task ${task.status} 唔可以取消` }, { status: 409 });
    }
    await prisma.followupTask.update({
      where: { id },
      data: { status: "CANCELLED", cancelReason: "MANUAL", handledAt: new Date(), handledBy: ctx.staff.id },
    });
    await prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "FOLLOWUP_CANCELLED",
        entity: "FollowupTask",
        entityId: id,
        meta: { clinicId: task.clinicId, reason: "MANUAL" } as object,
      },
    });
    return NextResponse.json({ ok: true, result: { status: "CANCELLED" } });
  }

  // send — 引擎統一入口（取消檢查 + 窗口 + template 審批 + audit 全部喺度）
  const result = await sendFollowupTask(id, { via: "AI_ADOPTED", staffId: ctx.staff.id });
  return NextResponse.json({ ok: result.status !== "NOT_DUE", result });
});
