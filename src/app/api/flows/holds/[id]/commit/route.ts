/**
 * POST /api/flows/holds/[id]/commit — 預約卡「已入 Apricot · 完成」掣（providerslot-20260830 T3）
 *
 * 狀態機：只 HELD 可 commit（其餘 → 409）。
 * 1. RBAC：assertClinicAccess（clinicId 缺失 = 只 ADMIN）
 * 2. call workforce commit（MD 3.3：HELD → IN_APRICOT；冪等）
 * 3. 本地 → COMMITTED + committedAt + AuditLog(COMMIT_HOLD)
 *
 * workforce fail（404/409 = 已 RELEASED）→ 本地 EXPIRED + 200 {already}；
 * 其他 fail（離線/超時）→ 502 保持 HELD（可重試）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { commitHold, WorkforceApiError, WorkforceOutcomeUnknown, fetchAppointments, updateBookingStatus, slotClaimEnabled } from "@/lib/workforce/client";
import { phoneHash } from "@/lib/phone-hash";
import { hkDateOffset } from "@/lib/availability";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const hold = await prisma.flowHoldEvent.findUnique({ where: { id } });
  if (!hold) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (hold.clinicId) assertClinicAccess(ctx, hold.clinicId);
  else if (ctx.staff.role !== "ADMIN") return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
  assertCanWriteConversation(ctx); // ★ cwi-routing-20260906 §8：SUPERVISOR 覆客 403
  if (!slotClaimEnabled()) return NextResponse.json({ error: "SLOT_CLAIM_DISABLED" }, { status: 403 }); // ★ cwi-final S0-12：G2 閘

  if (hold.status !== "HELD") {
    return NextResponse.json({ error: `hold already ${hold.status}`, status: hold.status }, { status: 409 });
  }
  if (!hold.workforceHoldId) {
    return NextResponse.json({ error: "workforce hold id missing" }, { status: 500 });
  }

  let wf;
  try {
    wf = await commitHold(hold.workforceHoldId);
  } catch (err) {
    if (err instanceof WorkforceApiError && (err.status === 404 || err.status === 409)) {
      // workforce 端已放開（RELEASED/時間過）→ 本地 EXPIRED，卡轉「已過期」
      await prisma.flowHoldEvent.update({ where: { id: hold.id }, data: { status: "EXPIRED" } });
      log.info({ id, wfStatus: err.status }, "hold commit: workforce 已放開 → EXPIRED");
      return NextResponse.json({ ok: true, status: "EXPIRED", already: true });
    }
    log.warn({ id, err: err instanceof Error ? err.name : "?" }, "hold commit: workforce fail → 502（保持 HELD 可重試）");
    return NextResponse.json({ error: "workforce unavailable — 請重試" }, { status: 502 });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.flowHoldEvent.update({
      where: { id: hold.id },
      data: { status: "COMMITTED", committedAt: now },
    }),
    prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "COMMIT_HOLD",
        entity: "FlowHoldEvent",
        entityId: hold.id,
        meta: { holdId: hold.workforceHoldId, clinicCode: hold.clinicCode, date: hold.date } as object,
      },
    }),
  ]);
  log.info({ id, wfStatus: wf.status }, "hold commit: COMMITTED");

  // ★ cwi-final S5-8②（F2）：T4 改期唔取消舊單 — commit 成功 + 有改期 context → 102 舊單。
  //   冪等：idempotencyKey = resched-${hold.id}（重試同 key）；舊單已 102/-7/搵唔到 = no-op 當成功。
  //   失敗 → 207 + StaffNotice「新單已入，舊單標記失敗，請人手處理」（hold 仍 COMMITTED — 新單有效）。
  if (hold.rescheduleOfApptId) {
    const oldApptId = hold.rescheduleOfApptId;
    try {
      const data = await fetchAppointments(phoneHash(hold.patientPhone), hkDateOffset(-7), hkDateOffset(30));
      const oldAppt = data.appointments.find((a) => a.apricotApptId === oldApptId);
      if (oldAppt && oldAppt.bookingStatus === 0) {
        await updateBookingStatus(oldApptId, 102, { clinicCode: oldAppt.clinicCode, date: oldAppt.date }, `resched-${hold.id}`);
        log.info({ id, oldApptId }, "hold commit: 舊單已 102（改期 context）");
      } else {
        log.info(
          { id, oldApptId, seenStatus: oldAppt?.bookingStatus ?? null },
          "hold commit: 舊單已非 status 0（已 102/-7/搵唔到）— 冪等 no-op"
        );
      }
    } catch (err) {
      // 新單已 COMMITTED（有效）— 舊單標記失敗唔阻主流程；207 + StaffNotice 俾 staff 接手
      log.warn(
        { id, oldApptId, err: err instanceof Error ? err.name : "?" },
        "hold commit: 舊單 102 標記失敗 → 207 + StaffNotice（人手處理）"
      );
      if (hold.clinicId) {
        await prisma.staffNotice
          .create({
            data: {
              clinicId: hold.clinicId,
              conversationId: hold.conversationId ?? null,
              kind: "HANDOFF_REQUEST",
              title: `新單已入，舊單 ${oldApptId} 標記失敗，請人手處理`,
              meta: { holdId: hold.workforceHoldId ?? null, oldApptId, reason: err instanceof WorkforceApiError ? `workforce_${err.status}` : err instanceof WorkforceOutcomeUnknown ? "outcome_unknown" : "error" },
            },
          })
          .catch(() => undefined);
      } else {
        log.error({ id, oldApptId }, "hold commit: 舊單 102 失敗 + hold.clinicId 缺失（舊 row 防禦 case）— 無處落 StaffNotice，需人手核對");
      }
      return NextResponse.json(
        {
          ok: true,
          status: "COMMITTED",
          committedAt: now.toISOString(),
          oldApptMarked: false,
          notice: true,
          message: "新單已入，舊單標記失敗，請人手處理",
        },
        { status: 207 }
      );
    }
    return NextResponse.json({ ok: true, status: "COMMITTED", committedAt: now.toISOString(), oldApptMarked: true });
  }

  return NextResponse.json({ ok: true, status: "COMMITTED", committedAt: now.toISOString() });
});
