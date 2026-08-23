/**
 * duty-roster 消費端（MD §9.2 — 同 clinic-workforce 嘅唯一接口）。
 *
 * 契約（switch 後：clinic-workforce External API v1，經 workforce client 共用一條 HTTP 通道）：
 *   GET {WORKFORCE_API_URL}/api/external/v1/duty-roster?clinicCode=<code>&date=YYYY-MM-DD
 *   Header: x-api-key（WORKFORCE_API_KEY）
 *   → { v: 1, staff: [{ "staffName": str, "role": str, "shiftStart": "HH:mm", "shiftEnd": "HH:mm" }] }
 *
 * env：
 * - WORKFORCE_API_URL / WORKFORCE_API_KEY — 真 mode（同 availability 共用 workforce client）
 * - DUTY_MOCK=1 — sandbox/開發：回固定 fixture（3 人，決定性）— E2E 斷言用
 *
 * 行為（fail-soft，唔准 crash inbox）：
 * - 3s timeout（workforce client 內置）；404 / 401 / 5xx / timeout / 壞 shape → null（caller 顯示「隱藏卡」/ prompt 唔注入）
 * - ★ 欄位白名單：只有 staffName / role / shiftStart / shiftEnd 四欄入到
 *   inbox DB/UI/log（其餘欄位一律丟 — 薪酬/打卡永遠掂唔到，MD §9.2）
 * - log 只記「duty fetched, count=N」（metadata）—  staff 名入 UI 係設計（assign 參考），
 *   但 log 唔記名單（只記 count）。workforce client 自身 log 只 path+status。
 *
 * 5 分鐘 in-memory TTL cache（per clinic+date）：API route / AI worker / SSR 共用，
 * 避免每 5 分鐘 AI call 都打 workforce。
 */
import log from "@/lib/log";
import { fetchDutyRoster as wfFetchDutyRoster } from "@/lib/workforce/client";

export interface DutyEntry {
  staffName: string;
  role: string;
  shiftStart: string; // HH:mm
  shiftEnd: string;   // HH:mm
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 50;
const MAX_FIELD_LEN = 100;

/** HH:mm 格式校验（白名單 + shape defense）。 */
const RE_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** sandbox 決定性 fixture（DUTY_MOCK=1）— 3 人。 */
const MOCK_FIXTURE: DutyEntry[] = [
  { staffName: "林小曼", role: "前台", shiftStart: "09:00", shiftEnd: "17:00" },
  { staffName: "黃詩韻", role: "前台", shiftStart: "13:00", shiftEnd: "21:00" },
  { staffName: "張美玲", role: "護士", shiftStart: "10:00", shiftEnd: "18:00" },
];

interface CacheRow {
  at: number;
  entries: DutyEntry[] | null;
}
const cache = new Map<string, CacheRow>();

/** 今日 date（HK 日界 — 全系統統一慣例）：en-CA locale 回 YYYY-MM-DD。 */
export function hkToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
}

/**
 * 白名單 sanitize：只保留 4 欄 + 型別/長度/格式校验；壞 row → 整 row 丟。
 * @returns 合法 entries（可能空 array）或 null（整體 shape 壞）
 */
export function sanitizeDutyPayload(raw: unknown): DutyEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DutyEntry[] = [];
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const staffName = typeof o.staffName === "string" ? o.staffName.trim().slice(0, MAX_FIELD_LEN) : "";
    const role = typeof o.role === "string" ? o.role.trim().slice(0, MAX_FIELD_LEN) : "";
    const shiftStart = typeof o.shiftStart === "string" ? o.shiftStart.trim() : "";
    const shiftEnd = typeof o.shiftEnd === "string" ? o.shiftEnd.trim() : "";
    if (!staffName || !RE_HHMM.test(shiftStart) || !RE_HHMM.test(shiftEnd)) continue; // 壞 row 丟
    out.push({ staffName, role, shiftStart, shiftEnd });
  }
  return out;
}

/**
 * 攞當日當值名單。
 * @param clinicCode Clinic.code（TKW / MF ...）
 * @param date YYYY-MM-DD（預設今日 HK）
 * @returns entries（可能空 array = 當日無人當值）或 null（攞唔到 — 顯示層隱藏）
 */
export async function fetchDutyRoster(
  clinicCode: string,
  date: string = hkToday()
): Promise<DutyEntry[] | null> {
  const cacheKey = `${clinicCode}|${date}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;

  let entries: DutyEntry[] | null;

  if ((process.env.DUTY_MOCK ?? "1") === "1") {
    // sandbox 預設 mock — 決定性 fixture（E2E T38 斷言用）
    entries = MOCK_FIXTURE.map((e) => ({ ...e }));
    log.debug({ clinic: clinicCode, date, count: entries.length, mock: true }, "duty fetched (MOCK), count");
  } else {
    entries = await fetchReal(clinicCode, date);
  }

  // cache（null 都 cache — 3 秒內失敗唔好重打；TTL 5 分鐘）
  if (cache.size > 500) cache.clear(); // 防 leak（店×日 組合唔多）
  cache.set(cacheKey, { at: Date.now(), entries });
  return entries;
}

async function fetchReal(clinicCode: string, date: string): Promise<DutyEntry[] | null> {
  if (!process.env.WORKFORCE_API_URL) {
    log.warn({ clinic: clinicCode }, "duty: WORKFORCE_API_URL 未設定 → null（隱藏卡）");
    return null;
  }
  try {
    // switch：真 mode 經 workforce client（v1 endpoint + 3s timeout + log 只 path+status）
    const res = await wfFetchDutyRoster(clinicCode, date);
    // 白名單 defense 照舊（v1 staff 欄位同舊 shape 一樣，多一層過濾唔錯）
    const entries = sanitizeDutyPayload(res.staff);
    if (entries === null) {
      log.warn({ clinic: clinicCode, date }, "duty: response shape invalid → null（白名單 defense）");
      return null;
    }
    // ★ log 只記 count — 唔記名單
    log.info({ clinic: clinicCode, date, count: entries.length }, "duty fetched, count");
    return entries;
  } catch {
    // workforce client 已 log path+status（零 body）— 呢度只補 clinic/date metadata
    log.warn({ clinic: clinicCode, date }, "duty: workforce API fail → null（唔 crash）");
    return null;
  }
}

/** Test hook：清 cache（E2E 用）。 */
export function __resetDutyCache(): void {
  cache.clear();
}
