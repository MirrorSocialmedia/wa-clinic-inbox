/**
 * providerslot-20260830 T3 — Flow hold sweep（HELD 狀態推進 + HELD 逾時警報）
 *
 * 兩職責（冪等、可無數據空跑）：
 * 1. 狀態推進：本地 FlowHoldEvent（HELD）× workforce held API（逐 clinicCode 對返）：
 *    - workforce 端 IN_APRICOT（workforce 側 commit 咗）→ 本地 IN_APRICOT（卡「已入 Apricot · 完成」）
 *    - held list 冇咗（RELEASED / 預約時間已過 lazy sweep / TTL 釋放）→ 本地 EXPIRED
 *      + ★ cwi-final S5-4①/S5-11（F4）：HIGH alert `hold_expired_unhandled`（S1-1a 慣例）+ StaffNotice
 *      （「網上預約佔位已自動釋放 — 如果病人仲要呢個時段，請即刻入 Apricot」）
 *      **唔 resolve `held_timeout`**（spec 明確 — 需要人跟嘅 alert 只准人手 resolve）
 *    （inbox staff 撳「已入 Apricot · 完成」走另一條路：/api/flows/holds/[id]/commit → COMMITTED）
 * 2. 警報 upsert（MD §6）：workforce HELD ageHours > 12 → MEDIUM；> holdTimeoutHours(24) → HIGH。
 *    - 冪等 = Alert type=held_timeout + detail.holdId（重跑唔重複；升級/降級跟最新齡）
 *    - ★ cwi-final S5-11（F4）：唔再 auto-resolve（hold 消失 = 未處理問題，行 hold_expired_unhandled 路徑）
 *
 * 🔴 零病人 PII：workforce held API 只出 provider 層；Alert.detail 亦無任何病人欄位。
 * 觸發：cron `hold-sweep`（每 5 分鐘，workers）+ POST /api/admin/hold-sweep（手動，ADMIN）。
 */
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import log from "@/lib/log";
import { getHeld, type HeldItem, type HeldResult } from "@/lib/workforce/client";
import { upsertAlert } from "@/lib/health/alerts";
import { publishConvEvent, convRef } from "@/lib/notify";

export const HELD_ALERT_TYPE = "held_timeout";
/** MD §6 建議值（數值本身由 clinic.holdTimeoutHours 帶出 — 呢度只係 MEDIUM 門檻 + fallback） */
export const HELD_MEDIUM_AGE_HOURS = 12;
export const HELD_HIGH_FALLBACK_HOURS = 24;

export interface SweepSummary {
  checked: number;
  toInApricot: number;
  toExpired: number;
  clinicsFailed: string[];
  alerts: { created: number; updated: number; resolved: number; open: number };
}

/**
 * 對 workforce held 列表做本地 FlowHoldEvent 狀態推進 + held_timeout alert upsert。
 * 任何 clinic 的 API 失敗 = 該 clinic skip（fail-soft — 唔阻其餘店、唔 throw）。
 */
export async function sweepFlowHolds(): Promise<SweepSummary> {
  const summary: SweepSummary = {
    checked: 0,
    toInApricot: 0,
    toExpired: 0,
    clinicsFailed: [],
    alerts: { created: 0, updated: 0, resolved: 0, open: 0 },
  };

  const active = await prisma.flowHoldEvent.findMany({
    where: { status: "HELD" },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  summary.checked = active.length;
  if (active.length === 0) {
    // 空跑（T4 未上線期常态）— alert 側照做（workforce 可能有 inbox 未記錄嘅 hold）
    await syncHeldAlerts(null, summary);
    return summary;
  }

  // 本地 event 按 clinic 分組 → 逐店對返
  const byClinic = new Map<string, typeof active>();
  for (const ev of active) {
    const list = byClinic.get(ev.clinicCode) ?? [];
    list.push(ev);
    byClinic.set(ev.clinicCode, list);
  }

  for (const [clinicCode, events] of byClinic) {
    let held: HeldResult;
    try {
      held = await getHeld(clinicCode);
    } catch (err) {
      summary.clinicsFailed.push(clinicCode);
      log.warn(
        { clinic: clinicCode, err: err instanceof Error ? err.name : "?" },
        "hold-sweep: workforce held fail → 該店 skip"
      );
      continue;
    }
    const wfByHoldId = new Map(held.holds.map((h) => [h.holdId, h]));
    for (const ev of events) {
      if (!ev.workforceHoldId) continue;
      const wf = wfByHoldId.get(ev.workforceHoldId);
      if (!wf) {
        await prisma.flowHoldEvent.update({ where: { id: ev.id }, data: { status: "EXPIRED" } });
        summary.toExpired += 1;
        // ★ cwi-final S5-4①/S5-11（F4）：hold 喺 workforce 消失（404/RELEASED）→ HIGH alert + StaffNotice
        //   （fail-soft — 警報/通知失敗唔阻其餘 hold 推進；**唔** resolve held_timeout）
        await notifyHoldExpired(ev);
      } else if (wf.status === "IN_APRICOT") {
        await prisma.flowHoldEvent.update({ where: { id: ev.id }, data: { status: "IN_APRICOT" } });
        summary.toInApricot += 1;
      }
      // wf.status === HELD → 不變（齡由 workforce 計，alert 側處理）
    }
  }

  await syncHeldAlerts(null, summary);
  return summary;
}

/**
 * ★ cwi-final S5-4①/S5-11（F4）：hold 喺 workforce 消失（本地轉 EXPIRED）→ HIGH alert + StaffNotice。
 * - alert type=hold_expired_unhandled（S1-1a upsertAlert 慣例；detail 帶 holdId 冪等 + 零病人 PII）
 * - StaffNotice：有 conversationId → 發該對話（+ notice:new 實時 push）；無 → 店級（conversationId null）
 * - **唔 resolve `held_timeout`**（spec 明確 — 「需要人跟」alert 只准人手 resolve）
 * fail-soft：任何失敗 log 唔 throw（sweep 唔准郁）。
 */
async function notifyHoldExpired(
  ev: {
    id: string;
    clinicId: string | null;
    clinicCode: string;
    date: string;
    startMin: number;
    endMin: number;
    providerName: string;
    workforceHoldId: string | null;
    conversationId: string | null;
  },
): Promise<void> {
  try {
    await upsertAlert({
      type: "hold_expired_unhandled",
      severity: "HIGH",
      clinicId: ev.clinicId,
      clinicCode: ev.clinicCode,
      detail: {
        holdId: ev.id,
        workforceHoldId: ev.workforceHoldId,
        clinicCode: ev.clinicCode,
        date: ev.date,
        startMin: ev.startMin,
        endMin: ev.endMin,
        providerName: ev.providerName,
      },
    });
    // StaffNotice.clinicId 必填 — FlowHoldEvent.clinicId null（搵唔到店）→ 按 code 兜底
    let clinicId = ev.clinicId;
    if (!clinicId) {
      const c = await prisma.clinic.findUnique({ where: { code: ev.clinicCode }, select: { id: true } });
      clinicId = c?.id ?? null;
    }
    if (!clinicId) {
      log.warn({ holdId: ev.id, clinic: ev.clinicCode }, "hold-sweep: EXPIRED 通知跳過 — 搵唔到 clinicId");
      return;
    }
    await prisma.staffNotice.create({
      data: {
        clinicId,
        conversationId: ev.conversationId, // null = 店級通知（spec：無對話 → 發店級）
        kind: "SYSTEM",
        title: "網上預約佔位已自動釋放 — 如果病人仲要呢個時段，請即刻入 Apricot",
        meta: {
          holdId: ev.id,
          workforceHoldId: ev.workforceHoldId,
          clinicCode: ev.clinicCode,
          providerName: ev.providerName,
          date: ev.date,
          startMin: ev.startMin,
          endMin: ev.endMin,
        } as Prisma.InputJsonValue,
      },
    });
    // 有對話 → commit-then-emit（routing 慣例）— 實時 push 該對話
    if (ev.conversationId) {
      const convRow = await prisma.conversation.findUnique({
        where: { id: ev.conversationId },
        select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
      });
      if (convRow) {
        await publishConvEvent(convRef(convRow), "notice:new", {
          clinicId,
          conversationId: ev.conversationId,
          kind: "SYSTEM",
        });
      }
    }
  } catch (err) {
    log.error(
      { holdId: ev.id, err: err instanceof Error ? err.message : String(err) },
      "hold-sweep: EXPIRED alert/notice 失敗（fail-soft — 唔阻 sweep）"
    );
  }
}

/**
 * held_timeout alert 同步（全部店）：
 * - 逐 clinic getHeld → HELD 且 age>12h → upsert alert（MEDIUM/HIGH）
 * - ★ cwi-final S5-11（F4）：唔再 auto-resolve — hold 消失已轉 EXPIRED 行 hold_expired_unhandled
 *   HIGH alert；held_timeout 係「需要人跟」alert，只准人手 resolve（R-28 同一原則）
 */
async function syncHeldAlerts(_unused: unknown, summary: SweepSummary): Promise<void> {
  const clinics = await prisma.clinic.findMany({ select: { id: true, code: true } });
  const allHeld: { clinicCode: string; clinicId: string; item: HeldItem; holdTimeoutHours: number }[] = [];
  for (const c of clinics) {
    let res: HeldResult;
    try {
      res = await getHeld(c.code);
    } catch (err) {
      if (!summary.clinicsFailed.includes(c.code)) summary.clinicsFailed.push(c.code);
      log.warn({ clinic: c.code, err: err instanceof Error ? err.name : "?" }, "hold-sweep: alerts fail → 該店 skip");
      continue;
    }
    const timeoutHours = res.holdTimeoutHours ?? HELD_HIGH_FALLBACK_HOURS;
    for (const item of res.holds) {
      allHeld.push({ clinicCode: c.code, clinicId: c.id, item, holdTimeoutHours: timeoutHours });
    }
  }

  const open = await prisma.alert.findMany({ where: { type: HELD_ALERT_TYPE, resolvedAt: null } });
  const byHoldId = new Map<string, (typeof open)[number]>();
  for (const a of open) {
    const hid = (a.detail as { holdId?: unknown } | null)?.holdId;
    if (typeof hid === "string") byHoldId.set(hid, a);
  }

  for (const { clinicCode, clinicId, item, holdTimeoutHours } of allHeld) {
    if (item.status !== "HELD" || item.ageHours <= HELD_MEDIUM_AGE_HOURS) continue;
    const severity = item.ageHours > holdTimeoutHours ? "HIGH" : "MEDIUM";
    const detail = {
      holdId: item.holdId,
      clinicCode,
      providerName: item.providerName,
      date: item.date,
      startMin: item.startMin,
      endMin: item.endMin,
      ageHours: item.ageHours,
      status: item.status,
      appointmentPast: item.appointmentPast,
    };
    const existing = byHoldId.get(item.holdId);
    if (existing) {
      await prisma.alert.update({
        where: { id: existing.id },
        data: { severity, clinicCode, clinicId, detail: detail as object },
      });
      summary.alerts.updated += 1;
    } else {
      await prisma.alert.create({
        data: { type: HELD_ALERT_TYPE, severity, clinicId, clinicCode, detail: detail as object },
      });
      summary.alerts.created += 1;
    }
  }

  // ★ cwi-final S5-11（F4）：auto-resolve 已移除（spec：唔好 resolve held_timeout）— byHoldId 只供上方 upsert 用
  void byHoldId;
  summary.alerts.open = Math.max(0, open.length + summary.alerts.created - summary.alerts.resolved);
}

/**
 * /admin 監看行（live — 唔落 DB）：逐店 getHeld fail-soft。
 * 零 PII（workforce 層數據原樣展示；唔 join 本地病人資料）。
 */
export interface HeldAlertRow {
  clinicCode: string;
  holdId: string;
  providerName: string;
  date: string;
  startMin: number;
  endMin: number;
  ageHours: number;
  status: "HELD" | "IN_APRICOT";
  appointmentPast: boolean;
  /** OK = <12h（唔算警報）/ MEDIUM / HIGH */
  severity: "OK" | "MEDIUM" | "HIGH";
}

export interface HeldAlertSnapshot {
  rows: HeldAlertRow[];
  /** 全部店都連唔到 = true（頁面顯示「未接通」） */
  allFailed: boolean;
  failedClinics: string[];
  holdTimeoutHours: number | null;
}

export async function getHeldAlertSnapshot(): Promise<HeldAlertSnapshot> {
  const clinics = await prisma.clinic.findMany({ select: { code: true } });
  const rows: HeldAlertRow[] = [];
  const failed: string[] = [];
  let holdTimeoutHours: number | null = null;
  for (const c of clinics) {
    try {
      const res = await getHeld(c.code);
      if (res.holdTimeoutHours != null) holdTimeoutHours = res.holdTimeoutHours;
      const timeout = res.holdTimeoutHours ?? HELD_HIGH_FALLBACK_HOURS;
      for (const h of res.holds) {
        const severity: HeldAlertRow["severity"] =
          h.status === "HELD" && h.ageHours > timeout ? "HIGH" : h.status === "HELD" && h.ageHours > HELD_MEDIUM_AGE_HOURS ? "MEDIUM" : "OK";
        rows.push({
          clinicCode: c.code,
          holdId: h.holdId,
          providerName: h.providerName,
          date: h.date,
          startMin: h.startMin,
          endMin: h.endMin,
          ageHours: h.ageHours,
          status: h.status,
          appointmentPast: h.appointmentPast,
          severity,
        });
      }
    } catch (err) {
      failed.push(c.code);
      log.warn({ clinic: c.code, err: err instanceof Error ? err.name : "?" }, "held-alerts: workforce fail → 該店 skip");
    }
  }
  rows.sort((a, b) => b.ageHours - a.ageHours);
  return { rows, allFailed: clinics.length > 0 && failed.length === clinics.length, failedClinics: failed, holdTimeoutHours };
}

export function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * conversation 渲染用：每個對話最新一條非終態 hold（HELD/IN_APRICOT/COMMITTED）。
 * ★ cwi-final S5-11（F4）：主配對 = conversationId（同號多病人唔會串卡）；
 *   舊行（conversationId null = F2 前）fallback phone 配對（patientPhone = Contact.waId）。
 * RELEASED/EXPIRED 唔帶（卡消失；過期行警報路徑）。
 * clinicId 傳入 = STAFF scope（fail-closed：本公司店）；ADMIN 傳 undefined。
 */
export interface HoldEventView {
  id: string;
  status: "HELD" | "IN_APRICOT" | "COMMITTED";
  providerName: string;
  date: string;
  startMin: number;
  endMin: number;
  patientName: string | null;
  patientPhone: string | null; // ★ S5-11（F4）：retention-purge 終態 90 日 → null（PII 清）
  // ★ cwi-final S5-11（F4）：卡片顯示「病人留嘅電話」（Flow 打嘅電話；同 patientPhone = WA 號分清）
  contactPhone: string | null;
  // ★ cwi-final S5-11（F4）：卡片顯示 clinic code（跨店 staff 分辨 hold 屬邊間店）
  clinicCode: string;
  notes: string | null;
  source: string;
  committedAt: string | null;
  createdAt: string;
  // ★ cwi-final S5-8②（F2）：T4 改期 context（紅標用）— 舊單號 + 舊單日期時間（BR join；電話單 null）
  rescheduleOfApptId: string | null;
  rescheduleOfApptLabel: string | null;
}

export async function latestHoldsByConversation(
  convs: { id: string; waId?: string | null }[],
  clinicId?: string | string[] | null
): Promise<Map<string, HoldEventView>> {
  if (convs.length === 0) return new Map();
  const convIds = convs.map((c) => c.id);
  const rows = await prisma.flowHoldEvent.findMany({
    where: {
      conversationId: { in: convIds },
      status: { in: ["HELD", "IN_APRICOT", "COMMITTED"] },
      // cwi-h6-20260830：string[] = 多店員工（in）；string = 單店 / ADMIN 指定；undefined = 全店（ADMIN）
      ...(clinicId ? { clinicId: Array.isArray(clinicId) ? { in: clinicId } : clinicId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  // ★ cwi-final S5-11（F4）：舊行（conversationId null = F2 前）fallback phone 配對（只限呢批對話嘅 WA 號）
  const waIds = [...new Set(convs.map((c) => c.waId ?? null).filter((w): w is string => !!w))];
  if (waIds.length > 0) {
    const legacyRows = await prisma.flowHoldEvent.findMany({
      where: {
        conversationId: null,
        patientPhone: { in: waIds },
        status: { in: ["HELD", "IN_APRICOT", "COMMITTED"] },
        ...(clinicId ? { clinicId: Array.isArray(clinicId) ? { in: clinicId } : clinicId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    rows.push(...legacyRows);
  }
  // fallback phone 配對：waId → 呢批對話入面第一個同號 conv（舊行用）
  const convIdByPhone = new Map<string, string>();
  for (const c of convs) {
    if (c.waId && !convIdByPhone.has(c.waId)) convIdByPhone.set(c.waId, c.id);
  }
  const m = new Map<string, HoldEventView>();
  // ★ cwi-final S5-8②（F2）：改期 context 紅標 — 舊單日期/時間靠 join BookingRequest 補
  //   （FlowHoldEvent 本身無舊單 date/time 欄；電話落嘅 Apricot 單無 BR → label null → 卡顯示單號）
  const reschedHolds = rows.filter((r) => r.rescheduleOfApptId && r.conversationId);
  const apptLabelMap = new Map<string, string>();
  if (reschedHolds.length > 0) {
    const brs = await prisma.bookingRequest
      .findMany({
        where: {
          conversationId: { in: [...new Set(reschedHolds.map((r) => r.conversationId!))] },
          apricotApptId: { in: [...new Set(reschedHolds.map((r) => r.rescheduleOfApptId!))] },
        },
        select: { apricotApptId: true, requestedDate: true, requestedTime: true },
      })
      .catch(() => []);
    for (const b of brs) {
      apptLabelMap.set(b.apricotApptId!, `${b.requestedDate}${b.requestedTime ? ` ${b.requestedTime}` : ""}`);
    }
  }
  for (const r of rows) {
    // 主配對 = conversationId；舊行 fallback = phone → 呢批對話入面第一個同號 conv（purged 行 patientPhone=null → 無 fallback，靠 conversationId）
    const key = r.conversationId ?? (r.patientPhone ? convIdByPhone.get(r.patientPhone) : undefined);
    if (!key || m.has(key)) continue; // 已排序 desc — 第一條 = 最新
    m.set(key, {
      id: r.id,
      status: r.status as HoldEventView["status"],
      providerName: r.providerName,
      date: r.date,
      startMin: r.startMin,
      endMin: r.endMin,
      patientName: r.patientName,
      patientPhone: r.patientPhone,
      contactPhone: r.contactPhone,
      clinicCode: r.clinicCode,
      notes: r.notes,
      source: r.source,
      committedAt: r.committedAt ? r.committedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      rescheduleOfApptId: r.rescheduleOfApptId,
      rescheduleOfApptLabel: r.rescheduleOfApptId
        ? (apptLabelMap.get(r.rescheduleOfApptId) ?? null)
        : null,
    });
  }
  return m;
}
