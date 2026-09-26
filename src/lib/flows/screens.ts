/**
 * Flow data_exchange screen data（MD §8.2 + cwi-r2 2026-08-27 生產真 Flow v7.3 三屏）
 *
 * 原則：**每次 call 先經 getSlots()（四層降級鏈）確保 L2 新鮮，再查 AvailabilitySlot**
 *（precheck 原則：病人揀親 = 真有空）。NONE 變體（純收需求）由 endpoint 層處理。
 *
 * 舊 canvas 三 screen（legacy contract — e2e 回歸）：
 * - SCREEN_PROVIDER → 該店 active 醫生（Provider/ProviderClinic 對照）
 * - SCREEN_DATE     → 聽日 ~ +30 日，只回「該醫生有空檔」嘅日期
 * - SCREEN_TIME     → 該日該醫生空 slot 嘅 30 分鐘開始時間
 *
 * 生產真 Flow 三屏（MD §B3 — stateless data builder；endpoint 持有 rows，呢度只砌 shape）：
 * - SCR_DATE    → { dates[{id,title}]（v2：今日起30日內有空檔日）， has_error, error_message }
 * - SCR_SLOT    → { date_display, date, providers[{id,title}], times[{id,title}], has_error, error_message }
 * - SCR_CONFIRM → { summary_*, profile_name, date, provider_id, time, has_error, error_message }
 *
 * v2 契約（CEO NOTICE 2026-08-27 23:50）：has_error 必回明確 boolean；
 * has_error=true ⟺ error_message 非空（兩欄同送）；正常 = false + ""。
 *
 * §D remainingCapacity（cwi-r2）：「空 slot」統一 predicate = slotAvailable()
 *（isOpen && (remainingCapacity 缺欄→bookedCount===0 舊語義 / 有欄→>0)）—
 * capacity 係候選過濾；checkClash 係寫入時最終防線（兩層唔合併）。
 */
import prisma from "@/lib/prisma";
import { syncWindow, hkTodayStr, hkDateOffset, slotAvailable, type Degraded, type SlotRow } from "@/lib/availability";
import { fmtDateFull } from "@/lib/booking/session-engine";

export interface ProviderOption {
  id: string; // apricotId
  name: string;
}

/**
 * §D capacity-aware「空 slot」DB 條件：
 * - remainingCapacity 缺欄（workforce 未上 capacity）→ 舊語義 bookedCount=0（fallback=1 行為）
 * - remainingCapacity 有欄 → 以佢為準（>0 = 仲收得）
 */
const CAPACITY_OPEN = {
  OR: [{ remainingCapacity: null, bookedCount: 0 }, { remainingCapacity: { gt: 0 } }],
};

/** SCREEN_PROVIDER：該店醫生名錄（Provider/ProviderClinic — seed 派生 / admin 手動維護） */
export async function screenProviders(clinicId: string): Promise<ProviderOption[]> {
  const rows = await prisma.providerClinic.findMany({
    where: { clinicId, provider: { active: true, apricotId: { not: null } } },
    include: { provider: true },
    orderBy: { provider: { name: "asc" } },
  });
  return rows.map((r) => ({ id: r.provider.apricotId!, name: r.provider.name }));
}

/** SCREEN_DATE：聽日~+30 日，只回該醫生有「空 slot」嘅日期（決定性升冪） */
export async function screenDates(clinicId: string, providerApricotId: string): Promise<string[]> {
  const { start, end, dates } = syncWindow();
  const rows = await prisma.availabilitySlot.findMany({
    where: {
      clinicId,
      providerApricotId,
      date: { gte: start, lte: end },
      isOpen: true,
      ...CAPACITY_OPEN,
    },
    select: { date: true },
    distinct: ["date"],
  });
  const has = new Set(rows.map((r) => r.date));
  return dates.filter((d) => has.has(d));
}

/** SCREEN_TIME：該日該醫生有空嘅時段（HH:mm 開始時間，30 分鐘 slot） */
export async function screenTimes(
  clinicId: string,
  providerApricotId: string,
  date: string
): Promise<string[]> {
  const rows = await prisma.availabilitySlot.findMany({
    where: { clinicId, providerApricotId, date, isOpen: true, ...CAPACITY_OPEN },
    select: { startTime: true },
    orderBy: { startTime: "asc" },
  });
  return rows.map((r) => r.startTime);
}

// ══ 生產真 Flow v7.3 三屏 data builder（MD §B3） ══════════════════════════

export interface OptionItem {
  id: string;
  title: string;
}

export interface DateScreenData {
  dates: OptionItem[]; // v2：[{id: "YYYY-MM-DD", title: "M月D日(週X)"}] — 今日起 30 日內有空檔日（任何醫生），升序
  has_error: boolean; // v2：明確 boolean（true ⟺ error_message 非空）
  error_message: string;
}

export interface SlotScreenData {
  date_display: string; // 「日期：8月28日(五)」
  date: string; // 轉發用（Footer payload ${data.date}）
  providers: OptionItem[];
  times: OptionItem[];
  has_error: boolean;
  error_message: string;
}

export interface ConfirmScreenData {
  summary_date: string;
  summary_provider: string;
  summary_time: string;
  profile_name: string; // 預填 Contact.name（WA profile name）
  date: string; // 轉發用
  provider_id: string; // 轉發用
  time: string; // 轉發用
  has_error: boolean;
  error_message: string;
}

/**
 * ★ cwi-final S5-14①（P2「Flow 時段畫面」）：「醫生 · 時段」組合 list — 每個 item = 一個可約 slot
 *（真實審計發現：舊兩組 radio（醫生＋時段）各截 20 個 → 組合爆炸；改組合 list 每頁 20 +「更多」）。
 * - id = `${providerId}|${start}`（canvas 選中後原樣回傳 `selected`，endpoint 拆）
 * - 「更多」= canvas 重送 user_action: "submit_date"（同 date + page: N+1）
 * - 向下兼容：providers/times 去重 list 保留（e2e T677 grep time 字串照過；舊 canvas 照用）
 */
export interface SlotScreenDataV2 {
  date_display: string;
  date: string;
  /** 組合 list 當前頁（≤ page_size 個） */
  options: OptionItem[];
  page: number; // 1-based
  page_size: number;
  has_more: boolean;
  /** 向下兼容（e2e / 舊 canvas）：去重醫生/時段 list（各截 20） */
  providers: OptionItem[];
  times: OptionItem[];
  has_error: boolean;
  error_message: string;
}

/** 組合 list 每頁上限（= RadioButtonsGroup data-source 上限 20 — Flow spec） */
export const SLOT_PAGE_SIZE = 20;

/**
 * v2 INIT dates[]：今日起 30 日內（今日含，上限 30 個選項）、至少一個空檔（任何醫生任一時間）嘅日子。
 * 病人根本揀唔到無空檔日；剩餘 race（揀完先至被人搶走）→ 下游 has_error 兜底。
 * slots = getSlots() 嘅全 rows（all providers）；null（degraded NONE）→ []（endpoint 配 has_error=true）。
 */
export function dateOptionsFromSlots(slots: SlotRow[] | null): OptionItem[] {
  if (!slots || slots.length === 0) return [];
  const start = hkTodayStr();
  const end = hkDateOffset(30);
  const openDates = new Set(
    slots.filter((r) => r.date >= start && r.date <= end && slotAvailable(r)).map((r) => r.date),
  );
  return [...openDates].sort().slice(0, 30).map((d) => ({ id: d, title: fmtDateFull(d) }));
}

export function dateScreenData(opts: { degraded: Degraded | null; dates: OptionItem[] }): DateScreenData {
  // 同送規則：has_error=true ⟺ error_message 非空；正常 = false + ""
  if (opts.dates.length > 0) return { dates: opts.dates, has_error: false, error_message: "" };
  return {
    dates: [],
    has_error: true,
    error_message: opts.degraded === "NONE" ? "預約系統暫時唔到，請稍後再試" : "未來 30 日暫無空檔",
  };
}

export function slotScreenData(opts: {
  date: string;
  providers: ProviderOption[];
  times: string[];
  error?: string;
}): SlotScreenData {
  return {
    date_display: `日期：${fmtDateFull(opts.date)}`,
    date: opts.date,
    providers: opts.providers.slice(0, SLOT_PAGE_SIZE).map((p) => ({ id: p.id, title: p.name })),
    times: [...opts.times].sort().slice(0, SLOT_PAGE_SIZE).map((t) => ({ id: t, title: t })),
    has_error: opts.error != null,
    error_message: opts.error ?? "",
  };
}

/**
 * ★ S5-14①：組合 list 版 SCR_SLOT data（每頁 20 + has_more）。
 * 決定性排序：醫生名（zh-HK localeCompare）→ 時段（HH:mm 升冪）。
 * 驗證不受分頁影響：endpoint submit_slot 照對該日**全量** slots 重查（唔係當前頁）。
 */
export function slotScreenDataPaged(opts: {
  date: string;
  slots: { providerId: string; providerName: string; start: string }[];
  page?: number;
  error?: string;
}): SlotScreenDataV2 {
  const all = [...opts.slots].sort(
    (a, b) => a.providerName.localeCompare(b.providerName, "zh-HK") || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0),
  );
  const providerMap = new Map<string, string>();
  for (const s of all) if (!providerMap.has(s.providerId)) providerMap.set(s.providerId, s.providerName);
  const times = [...new Set(all.map((s) => s.start))].sort();
  const page = Math.max(1, Math.floor(opts.page ?? 1) || 1);
  const startIdx = (page - 1) * SLOT_PAGE_SIZE;
  const pageItems = all.slice(startIdx, startIdx + SLOT_PAGE_SIZE);
  return {
    date_display: `日期：${fmtDateFull(opts.date)}`,
    date: opts.date,
    options: pageItems.map((s) => ({ id: `${s.providerId}|${s.start}`, title: `${s.providerName} · ${s.start}` })),
    page,
    page_size: SLOT_PAGE_SIZE,
    has_more: all.length > startIdx + SLOT_PAGE_SIZE,
    providers: [...providerMap.entries()].map(([id, name]) => ({ id, title: name })).slice(0, SLOT_PAGE_SIZE),
    times: times.slice(0, SLOT_PAGE_SIZE).map((t) => ({ id: t, title: t })),
    has_error: opts.error != null,
    error_message: opts.error ?? "",
  };
}

export function confirmScreenData(opts: {
  date: string;
  providerId: string;
  providerName: string;
  time: string;
  profileName: string;
  error?: string;
}): ConfirmScreenData {
  return {
    summary_date: `日期：${fmtDateFull(opts.date)}`,
    summary_provider: `醫生：${opts.providerName}`,
    summary_time: `時間：${opts.time}`,
    profile_name: opts.profileName,
    date: opts.date,
    provider_id: opts.providerId,
    time: opts.time,
    has_error: opts.error != null,
    error_message: opts.error ?? "",
  };
}

// ══ T4（providerslot-20260830）：bookable 源 data builder ══════════════

/**
 * SCR_DATE data（T4 — DatePicker 版）：date_min/date_max（Flow JSON 真欄）+
 * dates[]（bookable 可約日 — e2e/兼容）+ error（v2 同送規則：has_error=true ⟺ error_message 非空）。
 */
export function bookableDateScreen(opts: {
  dateMin: string;
  dateMax: string;
  openDates: string[];
  error?: string;
}): DateScreenData & { date_min: string; date_max: string } {
  const dates = opts.openDates.slice(0, 30).map((d) => ({ id: d, title: fmtDateFull(d) }));
  return {
    date_min: opts.dateMin,
    date_max: opts.dateMax,
    dates,
    has_error: opts.error != null,
    error_message: opts.error ?? "",
  };
}
