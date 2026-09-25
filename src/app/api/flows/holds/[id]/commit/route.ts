/**
 * POST /api/flows/holds/[id]/commit — 預約卡「已入 Apricot · 完成」掣（providerslot-20260830 T3）
 *
 * 狀態機：只 HELD 可 commit（其餘 → 409）。
 * 1. RBAC：assertClinicAccess（clinicId 缺失 = 只 ADMIN）
 * 2. ★ cwi-final S5-11（F4）：body.apricotRef 必填 — fetchAppointments 核對單號存在 + 日期/時間一致
 *    （+ 本店 + 有效狀態 0/102）→ 唔一致 → 409 拒絕 + 提示（hold 留 HELD）
 * 3. call workforce commit（MD 3.3：HELD → IN_APRICOT；冪等）
 * 4. 本地 → COMMITTED + committedAt + apricotRef + AuditLog(COMMIT_HOLD)
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
  // ★ S5-11（F4）：patientPhone nullable（retention-purge 90 日清 PII）— HELD 行理論上一定有；
  //   缺失 = 異常（purge 誤傷 / 舊 row）→ 500 唔好 hash(null)
  if (!hold.patientPhone) {
    return NextResponse.json({ error: "hold 缺病人電話（PII 已清？）— 無法核對單號" }, { status: 500 });
  }

  // ★ cwi-final S5-11（F4）：commit 必填 Apricot 單號（staff 入完單先撳完成 — 防「卡撳咗但單未入」）
  const body = (await req.json().catch(() => null)) as { apricotRef?: unknown } | null;
  const apricotRef = String(body?.apricotRef ?? "").trim();
  if (!apricotRef || apricotRef.length > 64) {
    return NextResponse.json({ error: "請填 Apricot 單號先完成" }, { status: 400 });
  }

  // ★ cwi-final S5-11（F4）：fetchAppointments 核對單號存在 + 日期/時間一致（hold.date/startMin 為準）。
  //   唔一致 → 409 拒絕 + 提示（hold 留 HELD — staff 可重新核對）；workforce 離線 → 502（唔准未核對先 COMMITTED）。
  const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  try {
    const data = await fetchAppointments(phoneHash(hold.patientPhone), hold.date, hold.date);
    const appt = data.appointments.find((a) => a.apricotApptId === apricotRef);
    if (!appt) {
      return NextResponse.json({ error: `單號 ${apricotRef} 喺 Apricot 搵唔到 — 請核對單號（病人：${hold.patientName ?? hold.patientPhone}）` }, { status: 409 });
    }
    if (appt.date !== hold.date || appt.start !== hhmm(hold.startMin) || appt.end !== hhmm(hold.endMin)) {
      return NextResponse.json(
        { error: `單號 ${apricotRef} 時間（${appt.date} ${appt.start}–${appt.end}）同呢個 hold（${hold.date} ${hhmm(hold.startMin)}–${hhmm(hold.endMin)}）唔一致 — 請核對` },
        { status: 409 }
      );
    }
    // 本店 + 有效狀態（0 = 已約 / 102 = 改期）— 其他店 / 已取消單唔算數（防打錯單號）
    if (appt.clinicCode !== hold.clinicCode) {
      return NextResponse.json({ error: `單號 ${apricotRef} 唔屬呢間店（${appt.clinicCode} ≠ ${hold.clinicCode}）— 請核對` }, { status: 409 });
    }
    if (appt.bookingStatus !== 0 && appt.bookingStatus !== 102) {
      return NextResponse.json({ error: `單號 ${apricotRef} 狀態非有效預約（已取消/已放開？）— 請核對` }, { status: 409 });
    }
  } catch (err) {
    log.warn({ id, apricotRefLen: apricotRef.length, err: err instanceof Error ? err.name : "?" }, "hold commit: fetchAppointments 核對失敗 → 502");
    return NextResponse.json({ error: "clinic-workforce 連唔到，未能核對單號 — 請重試" }, { status: 502 });
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
      // ★ cwi-final S5-11（F4）：apricotRef 已核對（存在 + 時間一致 + 本店 + 有效狀態）→ 落庫留痕
      data: { status: "COMMITTED", committedAt: now, apricotRef },
    }),
    prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "COMMIT_HOLD",
        entity: "FlowHoldEvent",
        entityId: hold.id,
        meta: { holdId: hold.workforceHoldId, clinicCode: hold.clinicCode, date: hold.date, apricotRef } as object,
      },
    }),
  ]);
  log.info({ id, wfStatus: wf.status, apricotRef }, "hold commit: COMMITTED");

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
