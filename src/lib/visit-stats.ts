/**
 * ★ cwi-ux UX-07：病人記錄「最近到診分店／主診醫生」統計（spec §7.3 拍板 ③）
 *
 * 輸入 = CWM /patients/{id}/visits 行（past visits，visitDate desc，含 clinicCode + providerCode）。
 * 口徑：
 *   - 只數真到診：bookingStatus 1（已到診）/ 4（已完成）；
 *     排除 -3（爽約）/ 0（已約未到）/ 102（改期）等 — 爽約唔係到診。
 *   - 窗口 = 近 12 個月（365 日，HK 日界；YYYY-MM-DD 字串比較 = 日期序安全）。
 *   - 主診醫生 = 窗口內到診次數最多嘅醫生（平手 → 最近一次較後者；再平手 → code 升序，決定性）。
 *   - lastClinicCode = 主診醫生窗口內最近一次到診嘅店（「主診醫生最近當值嘅店」— 預約分店下拉預設值）。
 *   - 無任何可數行 → null（UI 唔顯示 — spec：冇記錄唔顯示）。
 *
 * 注意：visits 上限 100（CWM 端點 max）→ 12 個月內 >100 次到診嘅極端病人會少算（已知邊界，fail-soft）。
 */

/** 真到診狀態（1=已到診 / 4=已完成）。 */
const COUNT_STATUSES = new Set([1, 4]);

export interface VisitStatRow {
  visitDate: string; // YYYY-MM-DD
  clinicCode: string;
  providerCode: string | null;
  providerName: string | null;
  bookingStatus: number;
}

export interface PatientRecordVisitStats {
  windowDays: 365;
  /** 近 12 個月真到診總次數（y） */
  totalVisits12m: number;
  /** 主診醫生（近 12 個月最多次）；全數唔知醫生（providerCode 全 null）= null */
  primaryDoctor: {
    providerCode: string;
    providerName: string | null;
    /** 近 12 個月佢嘅次數（x） */
    count: number;
    /** 佢最近一次當值（為呢位病人）嘅店 — 預約分店下拉預設 */
    lastClinicCode: string | null;
    lastVisitDate: string;
  } | null;
  /** 最近一次真到診（任何醫生）— 「最近到診：YL · 張醫生（N 星期前）」 */
  latestVisit: {
    date: string;
    clinicCode: string;
    providerName: string | null;
  } | null;
}

/** today - 365d（YYYY-MM-DD；HK 日界由 caller 傳 HKT today 保證）。 */
export function windowCutoff(todayStr: string, days = 365): string {
  const t = new Date(`${todayStr}T00:00:00+08:00`);
  t.setDate(t.getDate() - days);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function computeVisitStats(
  visits: VisitStatRow[],
  todayStr: string,
  windowDays = 365
): PatientRecordVisitStats | null {
  const cutoff = windowCutoff(todayStr, windowDays);
  // CWM 已 desc；再排一次（決定性 + 唔信上游序）
  const counted = visits
    .filter((v) => COUNT_STATUSES.has(v.bookingStatus) && v.visitDate >= cutoff && v.visitDate <= todayStr)
    .slice()
    .sort((a, b) => b.visitDate.localeCompare(a.visitDate));
  if (!counted.length) return null;

  // 主診醫生聚合（providerCode null = 唔歸屬 — 計入 total 但唔計入醫生）
  const byProvider = new Map<string, { code: string; name: string | null; count: number; lastDate: string; lastClinicCode: string | null }>();
  for (const v of counted) {
    if (!v.providerCode) continue;
    const e = byProvider.get(v.providerCode);
    if (!e) {
      byProvider.set(v.providerCode, {
        code: v.providerCode,
        name: v.providerName,
        count: 1,
        lastDate: v.visitDate,
        lastClinicCode: v.clinicCode || null,
      });
    } else {
      e.count += 1;
    }
  }
  let primary: PatientRecordVisitStats["primaryDoctor"] = null;
  if (byProvider.size) {
    const top = [...byProvider.values()].sort(
      (a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate) || a.code.localeCompare(b.code)
    )[0];
    primary = {
      providerCode: top.code,
      providerName: top.name,
      count: top.count,
      lastClinicCode: top.lastClinicCode,
      lastVisitDate: top.lastDate,
    };
  }

  const latest = counted[0];
  return {
    windowDays: 365,
    totalVisits12m: counted.length,
    primaryDoctor: primary,
    latestVisit: latest
      ? { date: latest.visitDate, clinicCode: latest.clinicCode, providerName: latest.providerName }
      : null,
  };
}
