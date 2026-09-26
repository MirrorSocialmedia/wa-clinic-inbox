/**
 * ★ cwi-final S5-14（audit3 P2「時長」）：落單時長統一來源。
 *
 * 口徑（spec）：跟 visit reason 字典時長／原單時長；冇就 30。
 *   - visit reason 字典時長：CWM ApricotDictionary 目前**無 duration 欄**
 *     （dictionaries API 只回 apricotId/code/des — 2026-09-26 核）→ 來源預留：
 *     日後 CWM 加欄 + dictionaries 回 durationMin 後，喺 resolveDurationMin 填入即生效。
 *   - 原單時長：改期路徑有舊單（end - start）→ 用佢。
 *   - 冇 → DEFAULT_DURATION_MIN = 30。
 */

export const DEFAULT_DURATION_MIN = 30;

/** 原單時長（分鐘）：HH:mm start/end → end-start；無效／越界（>240 分鐘，防跨日壞數據）→ null */
export function durationFromAppointment(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const m1 = /^(\d{1,2}):(\d{2})$/.exec(start);
  const m2 = /^(\d{1,2}):(\d{2})$/.exec(end);
  if (!m1 || !m2) return null;
  const s = Number(m1[1]) * 60 + Number(m1[2]);
  const e = Number(m2[1]) * 60 + Number(m2[2]);
  const d = e - s;
  return d > 0 && d <= 240 ? d : null;
}

/**
 * 解時長（分鐘）：原單時長 > 預設 30。
 * ★ 字典時長來源預留（見檔頭）— CWM 加欄後喺呢度接入，唔使改 caller。
 */
export function resolveDurationMin(args: { start?: string | null; end?: string | null }): number {
  return durationFromAppointment(args.start, args.end) ?? DEFAULT_DURATION_MIN;
}
