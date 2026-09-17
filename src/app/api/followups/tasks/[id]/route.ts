import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { sendFollowupTask, skipFollowupTask } from "@/lib/followup/engine";

/**
 * ★ cwi-followup-v3-20260916：follow-up 建議卡操作（staff+，clinic scope）。
 *
 * POST /api/followups/tasks/:id  body { action: "send" | "skip" }
 *   send → 員工採用（過窗 = approved template 直發；窗口內亦可 — 發渲染後 template text）。
 *          行 sendFollowupTask()：SUGGESTED 守門 + 時效預檢 + 取消檢查重跑 + template 審批 gate
 *          → Message QUEUED + task SENT（sentVia 恒 AI_ADOPTED）+ audit。
 *   skip → 員工跳過：SUGGESTED → SKIPPED(MANUAL) + audit（B-4② dedup 窗口內同 trigger 同病人唔再出）。
 *   （窗口內 free-form 採用 = 建議卡「採用並編輯」入 composer → /api/messages/send 帶
 *     followupTaskId — 發送後 claim 做 SENT；同 AI 草稿卡一模一樣嘅流程。）
 *   權限：staff+（clinic scope 內）；零 claim（assigneeId 唔改）。
 *   回：{ ok, result: { status, cancelReason?, messageId?, viaTemplate? } }
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  const action = body?.action;
  if (action !== "send" && action !== "skip") {
    return NextResponse.json({ error: "action = send | skip" }, { status: 400 });
  }
  const task = await prisma.followupTask.findUnique({ where: { id } });
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const clinicSet = scopedClinicSet(ctx);
  if (clinicSet && !clinicSet.includes(task.clinicId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (action === "skip") {
    const result = await skipFollowupTask(id, { staffId: ctx.staff.id });
    return NextResponse.json({ ok: result.status === "SKIPPED", result });
  }

  // send — 引擎統一入口（守門 + 時效 + 取消檢查 + 窗口 + template 審批 + audit 全部喺度）
  const result = await sendFollowupTask(id, { staffId: ctx.staff.id });
  return NextResponse.json({ ok: result.status === "SENT", result });
});
