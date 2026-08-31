/**
 * providerslot-20260830 T3 — Flow hold sweep（HELD 狀態推進 + HELD 逾時警報）
 *
 * 兩職責（冪等、可無數據空跑）：
 * 1. 狀態推進：本地 FlowHoldEvent（HELD）× workforce held API（逐 clinicCode 對返）：
 *    - workforce 端 IN_APRICOT（workforce 側 commit 咗）→ 本地 IN_APRICOT（卡「已入 Apricot · 完成」）
 *    - held list 冇咗（RELEASED / 預約時間已過 lazy sweep）→ 本地 EXPIRED
 *    （inbox staff 撳「已入 Apricot · 完成」走另一條路：/api/flows/holds/[id]/commit → COMMITTED）
 * 2. 警報 upsert（MD §6）：workforce HELD ageHours > 12 → MEDIUM；> holdTimeoutHours(24) → HIGH。
 *    - 冪等 = Alert type=held_timeout + detail.holdId（重跑唔重複；升級/降級跟最新齡）
 *    - hold 消失 → 對應未解決 alert auto-resolve
 *
 * 🔴 零病人 PII：workforce held API 只出 provider 層；Alert.detail 亦無任何病人欄位。
 * 觸發：cron `hold-sweep`（每 5 分鐘，workers）+ POST /api/admin/hold-sweep（手動，ADMIN）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getHeld, type HeldItem, type HeldResult } from "@/lib/workforce/client";

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
 * held_timeout alert 同步（全部店）：
 * - 逐 clinic getHeld → HELD 且 age>12h → upsert alert（MEDIUM/HIGH）
 * - 已唔喺 held list 嘅 held_timeout 未解決 alert → auto-resolve
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

  const seen = new Set<string>();
  for (const { clinicCode, clinicId, item, holdTimeoutHours } of allHeld) {
    if (item.status !== "HELD" || item.ageHours <= HELD_MEDIUM_AGE_HOURS) continue;
    seen.add(item.holdId);
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

  // 消失嘅 hold → auto-resolve
  for (const [holdId, a] of byHoldId) {
    if (seen.has(holdId)) continue;
    await prisma.alert.update({ where: { id: a.id }, data: { resolvedAt: new Date() } });
    summary.alerts.resolved += 1;
  }
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
 * conversation 渲染用：每個 WA 號最新一條非終態 hold（HELD/IN_APRICOT/COMMITTED）。
 * join key = patientPhone（= Contact.waId）。RELEASED/EXPIRED 唔帶（卡消失；過期行警報路徑）。
 * clinicId 傳入 = STAFF scope（fail-closed）；ADMIN 傳 undefined。
 */
export interface HoldEventView {
  id: string;
  status: "HELD" | "IN_APRICOT" | "COMMITTED";
  providerName: string;
  date: string;
  startMin: number;
  endMin: number;
  patientName: string | null;
  patientPhone: string;
  notes: string | null;
  source: string;
  committedAt: string | null;
  createdAt: string;
}

export async function latestHoldsByPhone(
  waIds: string[],
  clinicId?: string | string[] | null
): Promise<Map<string, HoldEventView>> {
  if (waIds.length === 0) return new Map();
  const rows = await prisma.flowHoldEvent.findMany({
    where: {
      patientPhone: { in: waIds },
      status: { in: ["HELD", "IN_APRICOT", "COMMITTED"] },
      // cwi-h6-20260830：string[] = 多店員工（in）；string = 單店 / ADMIN 指定
      ...(clinicId ? { clinicId: Array.isArray(clinicId) ? { in: clinicId } : clinicId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const m = new Map<string, HoldEventView>();
  for (const r of rows) {
    if (m.has(r.patientPhone)) continue; // 已排序 desc — 第一條 = 最新
    m.set(r.patientPhone, {
      id: r.id,
      status: r.status as HoldEventView["status"],
      providerName: r.providerName,
      date: r.date,
      startMin: r.startMin,
      endMin: r.endMin,
      patientName: r.patientName,
      patientPhone: r.patientPhone,
      notes: r.notes,
      source: r.source,
      committedAt: r.committedAt ? r.committedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    });
  }
  return m;
}
