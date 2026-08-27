/**
 * AvailabilitySlot = workforce API 嘅 L2 cache（切換 MD §3 — 由「舊直連 sync 結果」變「workforce L2」）
 *
 * ★ 唯一入口：所有空檔讀取（Flow endpoint / booking precheck / cron refresh / worker 啟動首跑）
 *   全部行 getSlots() — 冇第二條路。來源只係 clinic-workforce External API（舊直連來源
 *   已拆；mock 期 WORKFORCE_MOCK=1 行決定性 fixture grid）。
 *
 * 四層降級鏈（MD §3 拍板）：
 *   1) L2 fresh（syncedAt ≤ 5 分鐘）→ 即回，零 HTTP
 *   2) miss/過期 → fetchAvailability() → upsert L2（syncedAt 用 response 嘅）→ 回
 *      ├─ response.stale=true → 照用，回 degraded: "STALE_SOURCE"（workforce 對上游 過咗 30 分鐘）
 *   3) API fail（HTTP error / timeout / zod fail）→ 用過期 L2 照回 degraded: "STALE_CACHE"
 *   4) 連過期 cache 都冇 → degraded: "NONE"（caller 走「純收需求」intake 變體）
 *
 * getSlots 永不 throw（fail-soft）— 任何錯誤都歸入 3)/4)。
 * 副作：每次 fetch 成功/失敗都寫 WorkforceSyncState（metadata only — health-check 嘅
 * workforce_api_degraded 判斷訊號；零病人資料、零憑證）。
 * ★ PII：L2 只存時段佔用（slot 白名單欄）— 零病人資料（contract zod + pii-scan 斷言兜底）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { fetchAvailability, WorkforceApiError, type WorkforceAvailability } from "@/lib/workforce/client";
import { ZodError } from "zod";

// ── types ───────────────────────────────────────────────────────────────────

export type Degraded = null | "STALE_SOURCE" | "STALE_CACHE" | "NONE";

export interface SlotRow {
  providerApricotId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  bookedCount: number;
  isOpen: boolean;
  /** §D（cwi-r2）：workforce 回報「仲收幾多病人」；null = 缺欄（workforce 未上 capacity）→ fallback 當 1 */
  remainingCapacity: number | null;
}

export interface GetSlotsResult {
  /** null = 層 4（NONE — 無數據亦無 cache）；[] = 有數據但全滿/全閉 */
  slots: SlotRow[] | null;
  degraded: Degraded;
  fromCache: boolean;
  /** 本次 query 嘅日期窗口（intake 變體嘅 DatePicker 邊界用） */
  window: { start: string; end: string };
}

/** L2 fresh 閾值（MD §3：≤ 5 分鐘即回，零 HTTP）。 */
export const L2_FRESH_MS = 5 * 60 * 1000;

// ── HK 日期（UTC+8 固定，無 DST） ────────────────────────────────────────────

export function hkTodayStr(now: Date = new Date()): string {
  const hk = new Date(now.getTime() + 8 * 3600 * 1000);
  return hk.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** HK 日界 +/− N 日（booking-ui patient-context 窗口用：今日-7 → 今日+30 = 38 日 ⊆ 契約 ≤38 日上限） */
export function hkDateOffset(days: number, now: Date = new Date()): string {
  return addDays(hkTodayStr(now), days);
}

/** 窗口：聽日 ~ +30 日（HK 日界 — 同 Flow DatePicker min=聽日 max=+30 對齊；30 日 ⊆ 契約 31 日上限） */
export function syncWindow(now: Date = new Date()): { start: string; end: string; dates: string[] } {
  const today = hkTodayStr(now);
  const start = addDays(today, 1);
  const end = addDays(today, 30);
  const dates: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  return { start, end, dates };
}

// ── L2 read / write ─────────────────────────────────────────────────────────

interface L2Read {
  rows: SlotRow[];
  maxSyncedAt: Date | null;
}

async function readL2(clinicId: string, from: string, to: string): Promise<L2Read> {
  const rows = await prisma.availabilitySlot.findMany({
    where: { clinicId, date: { gte: from, lte: to } },
    select: {
      providerApricotId: true,
      date: true,
      startTime: true,
      endTime: true,
      bookedCount: true,
      isOpen: true,
      remainingCapacity: true,
      syncedAt: true,
    },
  });
  let maxSyncedAt: Date | null = null;
  const out: SlotRow[] = [];
  for (const r of rows) {
    if (maxSyncedAt === null || r.syncedAt > maxSyncedAt) maxSyncedAt = r.syncedAt;
    out.push({
      providerApricotId: r.providerApricotId,
      date: r.date,
      startTime: r.startTime,
      endTime: r.endTime,
      bookedCount: r.bookedCount,
      isOpen: r.isOpen,
      remainingCapacity: r.remainingCapacity,
    });
  }
  return { rows: out, maxSyncedAt };
}

/** upsert L2（窗口級 清先寫 — 決定性；syncedAt 用 response 嘅，無數據日 → 只清）。 */
async function upsertL2(clinicId: string, resp: WorkforceAvailability, fetchedAt: Date): Promise<number> {
  const dates = resp.days.map((d) => d.date);
  if (dates.length === 0) return 0;
  const syncedAt = resp.syncedAt ? new Date(resp.syncedAt) : fetchedAt;
  const data = dates
    .map((date) => resp.days.find((d) => d.date === date)!)
    .flatMap((day) =>
      day.providers.flatMap((p) =>
        p.slots.map((s) => ({
          clinicId,
          providerApricotId: p.providerApricotId,
          date: day.date,
          startTime: s.start,
          endTime: s.end,
          bookedCount: s.bookedCount,
          isOpen: s.isOpen,
          remainingCapacity: s.remainingCapacity ?? null,
          syncedAt,
        })),
      ),
    );
  await prisma.$transaction([
    prisma.availabilitySlot.deleteMany({ where: { clinicId, date: { gte: dates[0], lte: dates[dates.length - 1] } } }),
    ...(data.length > 0 ? [prisma.availabilitySlot.createMany({ data })] : []),
  ]);
  return data.length;
}

// ── WorkforceSyncState（health-check 訊號 — metadata only） ─────────────────

function errorCode(err: unknown): string {
  if (err instanceof WorkforceApiError) return `http_${err.status}`;
  if (err instanceof ZodError) return "zod_invalid";
  const e = err as { name?: string; message?: string };
  if (e?.name === "TimeoutError" || /aborted|abort|timeout/i.test(e?.message ?? "")) return "timeout";
  return "other";
}

async function recordSyncState(
  clinicId: string,
  outcome: { ok: true; stale: boolean } | { ok: false; code: string },
): Promise<void> {
  try {
    if (outcome.ok) {
      await prisma.workforceSyncState.upsert({
        where: { clinicId },
        create: { clinicId, lastOkAt: new Date(), lastStale: outcome.stale },
        update: { lastOkAt: new Date(), lastStale: outcome.stale },
      });
    } else {
      // create 分支：从未成功過（首事件即 fail）— lastOkAt 係 schema NOT NULL 必填，
      // 填 now = 等同「从未 sync 15 分鐘 grace」语义（health-check 喺 lastOkAt 過期先 alert）。
      // 唔好誤讀成「有成功記錄」— lastErrorAt/lastErrorCode 先係真實訊號。
      await prisma.workforceSyncState.upsert({
        where: { clinicId },
        create: { clinicId, lastOkAt: new Date(), lastErrorAt: new Date(), lastErrorCode: outcome.code },
        update: { lastErrorAt: new Date(), lastErrorCode: outcome.code },
      });
    }
  } catch (e) {
    // state 寫失敗唔阻主流程（health-check 會照樣睇 lastOkAt 新鮮度）
    log.warn({ clinicId, err: e instanceof Error ? e.message : String(e) }, "availability: WorkforceSyncState upsert failed");
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

function filterProvider(rows: SlotRow[], providerApricotId?: string): SlotRow[] {
  return providerApricotId ? rows.filter((r) => r.providerApricotId === providerApricotId) : rows;
}

/**
 * 攞空檔（唯一入口 — MD §3 四層降級鏈）。
 * @param clinicId 店 id
 * @param window 窗口（預設 syncWindow() = 聽日~+30；to-start ≤ 31 日 — workforce 契約上限）
 * @param providerApricotId 選填（唔傳 = 該店全部醫生）
 * @returns slots=null 只代表 NONE（無數據 + 無 cache）；API 健康但全滿 = []（degraded=null）
 */
export async function getSlots(
  clinicId: string,
  window: { start: string; end: string } = syncWindow(),
  providerApricotId?: string,
): Promise<GetSlotsResult> {
  const now = new Date();
  const { start: from, end: to } = window;

  // 1) L2 fresh（syncedAt ≤ 5 分鐘）→ 即回，零 HTTP
  const l2 = await readL2(clinicId, from, to);
  if (l2.rows.length > 0 && l2.maxSyncedAt !== null && now.getTime() - l2.maxSyncedAt.getTime() <= L2_FRESH_MS) {
    return { slots: filterProvider(l2.rows, providerApricotId), degraded: null, fromCache: true, window: { start: from, end: to } };
  }

  // 2) miss/過期 → API + upsert（clinic 級 fetch — 一網打晒該店醫生，避免逐醫 HTTP）
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { code: true } });
  const clinicCode = clinic?.code ?? clinicId;
  try {
    const resp = await fetchAvailability(clinicCode, from, to);
    const written = await upsertL2(clinicId, resp, now);
    const rows = resp.days.flatMap((day) =>
      day.providers.flatMap((p) =>
        p.slots.map((s): SlotRow => ({
          providerApricotId: p.providerApricotId,
          date: day.date,
          startTime: s.start,
          endTime: s.end,
          bookedCount: s.bookedCount,
          isOpen: s.isOpen,
          remainingCapacity: s.remainingCapacity ?? null,
        })),
      ),
    );
    await recordSyncState(clinicId, { ok: true, stale: resp.stale });
    if (resp.stale) {
      log.warn({ clinic: clinicCode, from, to, written }, "availability: STALE_SOURCE（workforce 源 >30 分鐘 — 照用）");
    } else {
      log.info({ clinic: clinicCode, from, to, written }, "availability: workforce fetch ok（L2 upserted）");
    }
    return { slots: filterProvider(rows, providerApricotId), degraded: resp.stale ? "STALE_SOURCE" : null, fromCache: false, window: { start: from, end: to } };
  } catch (err) {
    // 3) API fail（HTTP error / timeout / zod fail）→ 過期 L2 照回
    const code = errorCode(err);
    const msg = err instanceof Error ? err.message : String(err);
    // ★ log 只記 metadata（WorkforceApiError message = "workforce API HTTP <status> <path>" — 零 body）
    log.warn({ clinic: clinicCode, from, to, code, err: msg.slice(0, 120) }, "availability: workforce API fail → STALE_CACHE/NONE");
    await recordSyncState(clinicId, { ok: false, code });
    if (l2.rows.length > 0) {
      return { slots: filterProvider(l2.rows, providerApricotId), degraded: "STALE_CACHE", fromCache: true, window: { start: from, end: to } };
    }
    // 4) 連過期 cache 都冇
    return { slots: null, degraded: "NONE", fromCache: false, window: { start: from, end: to } };
  }
}

// ── cron / worker 啟動用：逐店刷新 ──────────────────────────────────────────

/**
 * 逐店 getSlots()（sync-availability cron 每 15 分鐘 + worker 啟動首跑）。
 * 單店失敗唔阻其他店（getSlots 本身 fail-soft — failed 計 NONE/STALE_CACHE 店數）。
 */
export async function refreshAllClinics(): Promise<{ total: number; ok: number; failed: number }> {
  const clinics = await prisma.clinic.findMany({ select: { id: true, code: true }, orderBy: { code: "asc" } });
  let ok = 0;
  let failed = 0;
  for (const c of clinics) {
    try {
      const r = await getSlots(c.id);
      if (r.degraded === null) ok += 1;
      else failed += 1;
    } catch (e) {
      failed += 1;
      log.error({ clinic: c.code, err: e instanceof Error ? e.message : String(e) }, "refreshAllClinics: store failed");
    }
  }
  log.info({ total: clinics.length, ok, failed }, "refreshAllClinics done");
  return { total: clinics.length, ok, failed };
}

// ── 消費端 helper（Flow endpoint / precheck 共用） ───────────────────────────

/**
 * §D（cwi-r2）：「空 slot」統一 predicate。
 * - remainingCapacity 有欄 → 以佢為準（>0 = 仲收得；workforce 已計入併诊規則）
 * - remainingCapacity 缺欄（null）→ 舊語義 bookedCount===0（fallback 當 capacity=1，向後兼容）
 * capacity 係候選過濾層；checkClash / precheck 係寫入時防線（兩層唔合併）。
 */
export function slotAvailable(r: SlotRow): boolean {
  if (!r.isOpen) return false;
  return r.remainingCapacity != null ? r.remainingCapacity > 0 : r.bookedCount === 0;
}

/** 空 slot（開診 + 未滿 — §D capacity-aware）。 */
export function openSlots(rows: SlotRow[]): SlotRow[] {
  return rows.filter(slotAvailable);
}

/** 有空 slot 嘅日期集合（決定性升冪）。 */
export function distinctDates(rows: SlotRow[]): string[] {
  return [...new Set(openSlots(rows).map((r) => r.date))].sort();
}

/** 該日空 slot 嘅開始時間（升冪）。 */
export function startTimes(rows: SlotRow[]): string[] {
  return openSlots(rows).map((r) => r.startTime).sort();
}
