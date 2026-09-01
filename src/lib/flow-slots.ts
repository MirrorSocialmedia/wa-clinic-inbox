/**
 * /api/flows/slots 資料 builder（cwi-sched-20260901 §2）— 保留 provider 維度
 *
 * 取代舊「聚合結果」shape：days[] 內嵌 duty[]（duty-roster）+ providers[]
 *（providerId / providerName / onlineSeats / slots[]）。duty 同 slots 一次過回 —
 * 減一個 round trip，兼保證兩者同一 syncedAt。
 *
 * 上游（全部 fail-soft — 任何一個掛咗都唔會令 route 500）：
 *   ① workforce bookable-slots（只出 offerable 格 — external 契約唔出非 offerable）
 *   ② workforce held（HELD / IN_APRICOT — 併入 TAKEN）
 *   ③ duty roster（5 分鐘 in-process cache；DUTY_MOCK=1 走 fixture）
 *   ④ L2 新鮮度（AvailabilityCache.maxSyncedAt — 同舊行為一致）
 *
 * 四態映射（MD §2/§3；inbox 端無碎片數據 — external 契約唔出 fragment，
 * MANUAL_ONLY 係 enum 保留值，現行管線唔會發出）：
 *   TAKEN     = 有 active hold 覆蓋該 30 分鐘格（HELD / IN_APRICOT）
 *   ONLINE    = bookable-slots 有 offerable 格（seats = seatsFree）
 *   CLOSED    = 其餘（休診 / 未開診 / 滿 / 早過 lead time — external 唔會再分）
 *   MANUAL_ONLY = 碎片格（future：inbox 端有碎片數據先會發出）
 *
 * granularity：
 *   week = 唔回 slots（慳 payload — 週視圖只用 providerName + onlineSeats）
 *   day  = slots[] 只回非 CLOSED 格（缺 = CLOSED；client 補 48 格 grid）
 */
import prisma from "@/lib/prisma";
import { fetchDutyRoster, type DutyEntry } from "@/lib/duty/client";
import { getBookableSlots, getHeld, type HeldResult } from "@/lib/workforce/client";
import { getSlotFreshness } from "@/lib/availability";

export type SlotState = "ONLINE" | "MANUAL_ONLY" | "TAKEN" | "CLOSED";

export interface FlowSlot {
  start: string; // HH:mm
  end: string;   // HH:mm
  state: SlotState;
  seats: number; // ONLINE = seatsFree；其餘 = 0
}

export interface FlowProvider {
  providerId: string;
  providerName: string;
  /** 可上線約總席（該日 offerable 格 seatsFree 加總） */
  onlineSeats: number;
  /** granularity=day 先有；只含非 CLOSED 格（缺 = CLOSED） */
  slots?: FlowSlot[];
}

export interface FlowDay {
  date: string; // YYYY-MM-DD
  /** 休診（workforce：冇醫生當值） */
  closed: boolean;
  duty: DutyEntry[];
  providers: FlowProvider[];
}

export interface FlowSlotsResult {
  ok: true;
  /** shape 版本：v2 = provider 分組（v1 = 舊聚合） */
  v: 2;
  clinicCode: string;
  from: string;
  to: string;
  granularity: "week" | "day";
  /** bookable-slots 連唔到（fail-soft 標誌 — UI「未接通」pattern） */
  connected: boolean;
  /** L2 新鮮度（同 duty 同一個值 — MD §2「同一 syncedAt」） */
  syncedAt: string | null;
  stale: boolean;
  days: FlowDay[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function hhmmToMin(hhmm: string): number | null {
  if (!HHMM_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function addDaysUTC(dateStr: string, n: number): string {
  // 純日曆日運算：按 UTC 午夜解（+08:00 解會令 toISOString 跨日界 — 慣例 bug）
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** from..to（含端點）逐日清單；span > maxSpan → 截尾。 */
function dateRange(from: string, to: string, maxSpan: number): string[] {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return [];
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const n = Math.min(span, maxSpan - 1) + 1;
  return Array.from({ length: n }, (_, i) => addDaysUTC(from, i));
}

/**
 * 搵指定店 window 嘅 doctor schedule 數據（duty + slots 一次過）。
 * 全程 fail-soft：bookable / held / duty 任何一個掛 → 該部分空，route 照 200。
 */
export async function buildFlowSlots(
  clinicCode: string,
  from: string,
  to: string,
  granularity: "week" | "day",
): Promise<FlowSlotsResult> {
  const dates = dateRange(from, to, 7);
  if (dates.length === 0) {
    return {
      ok: true, v: 2, clinicCode, from, to, granularity,
      connected: false, syncedAt: null, stale: false, days: [],
    };
  }

  // 上游全部 fail-soft（平行）
  const [bookable, held, clinicRow, dutyMap] = await Promise.all([
    getBookableSlots(clinicCode, from, to).catch(() => null),
    getHeld(clinicCode).catch(() => null),
    prisma.clinic.findUnique({ where: { code: clinicCode }, select: { id: true } }).catch(() => null),
    Promise.all(dates.map(async (d) => [d, await fetchDutyRoster(clinicCode, d).catch(() => null)] as const)),
  ]);
  const freshness = clinicRow
    ? await getSlotFreshness(clinicRow.id, from, to)
    : { maxSyncedAt: null, stale: false };
  const dutyByDate = new Map(dutyMap);

  const bookableByDate = new Map((bookable?.days ?? []).map((d) => [d.date, d]));
  const holdsByDate = new Map<string, HeldResult["holds"]>();
  for (const h of held?.holds ?? []) {
    // 只計 active hold（HELD / IN_APRICOT — 兩樣都係「已佔」）
    if (h.status !== "HELD" && h.status !== "IN_APRICOT") continue;
    const list = holdsByDate.get(h.date) ?? [];
    list.push(h);
    holdsByDate.set(h.date, list);
  }

  const days: FlowDay[] = [];
  for (const date of dates) {
    const bDay = bookableByDate.get(date) ?? null;
    const closed = bDay ? bDay.closed : false;
    const holds = holdsByDate.get(date) ?? [];

    // provider 集合 = 該日 offerable slots ∪ active holds（full 但冇 hold 嘅醫生
    // external 契約無數據 → 無法列名 — 已知限制，MD §2 shape 內可表達範圍內做齊）
    const byProvider = new Map<string, { name: string; seats: number; cells: Map<number, number> }>();
    for (const s of bDay?.slots ?? []) {
      const e = byProvider.get(s.providerId) ?? { name: s.providerName, seats: 0, cells: new Map<number, number>() };
      e.seats += s.seatsFree;
      const startMin = hhmmToMin(s.start);
      if (startMin !== null) e.cells.set(startMin, s.seatsFree);
      byProvider.set(s.providerId, e);
    }
    for (const h of holds) {
      if (!byProvider.has(h.providerId)) {
        byProvider.set(h.providerId, { name: h.providerName, seats: 0, cells: new Map() });
      }
    }

    const providers: FlowProvider[] = [...byProvider.entries()]
      .map(([providerId, e]) => {
        const p: FlowProvider = { providerId, providerName: e.name, onlineSeats: e.seats };
        if (granularity === "day") {
          // 48 格（30 分鐘）：TAKEN（hold 全覆蓋）> ONLINE（offerable）> CLOSED（缺）
          const slots: FlowSlot[] = [];
          for (let m = 0; m < 1440; m += 30) {
            const covered = holds.some((h) => h.startMin <= m && h.endMin >= m + 30);
            if (covered) {
              slots.push({ start: minToHHmm(m), end: minToHHmm(m + 30), state: "TAKEN", seats: 0 });
            } else {
              const free = e.cells.get(m);
              if (free !== undefined) {
                slots.push({ start: minToHHmm(m), end: minToHHmm(m + 30), state: "ONLINE", seats: free });
              }
            }
          }
          p.slots = slots;
        }
        return p;
      })
      .sort((a, b) => b.onlineSeats - a.onlineSeats || a.providerName.localeCompare(b.providerName, "zh-HK"));

    days.push({
      date,
      closed,
      duty: (dutyByDate.get(date) ?? []).slice().sort((a, b) => a.shiftStart.localeCompare(b.shiftStart)),
      providers,
    });
  }

  return {
    ok: true,
    v: 2,
    clinicCode,
    from: dates[0],
    to: dates[dates.length - 1],
    granularity,
    connected: bookable !== null,
    syncedAt: freshness.maxSyncedAt ? freshness.maxSyncedAt.toISOString() : null,
    stale: freshness.stale,
    days,
  };
}
