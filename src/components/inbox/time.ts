/** 時間顯示 helper（zh-Hant，inbox 用）。 */

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("zh-Hant-HK", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("zh-Hant-HK", { month: "short", day: "numeric" });
}

/** 相對時間：剛剛 / x 分鐘前 / x 小時前 / 日期 */
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < 60_000) return "剛剛";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  const d = new Date(t);
  if (sameDay(d, new Date(now))) return fmtTime(d);
  if (diff < 86_400_000 * 7) return `${d.toLocaleDateString("zh-Hant-HK", { weekday: "short" })} ${fmtTime(d)}`;
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

/** 氣泡內 timestamp：同日顯示時間，否則 日期+時間 */
export function bubbleTime(iso: string, prevIso?: string): string {
  const d = new Date(iso);
  if (prevIso && sameDay(new Date(prevIso), d)) return fmtTime(d);
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

/** 窗口倒數：23h 58m / 5h 12m / 已過窗 */
export function windowCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return "窗口已過";
  const h = Math.floor(remainingMs / 3_600_000);
  const m = Math.floor((remainingMs % 3_600_000) / 60_000);
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

/** 而家 HK 分鐘（0..1439）— Intl + Asia/Hong_Kong（同 hkToday 慣例；client 端）。 */
export function hkNowMin(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  let h = 0;
  let mi = 0;
  for (const part of parts) {
    if (part.type === "hour") h = Number(part.value) % 24;
    else if (part.type === "minute") mi = Number(part.value);
  }
  return h * 60 + mi;
}

/** "HH:mm" → 分鐘（0..1439）；壞格式 → null */
export function hhmmToMin(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
