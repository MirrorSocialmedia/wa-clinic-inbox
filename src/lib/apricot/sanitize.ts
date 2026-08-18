/**
 * Apricot overview response — PII 白名單 sanitize（MD §8.1 🔴 白名單制）
 *
 * getOverviewAppointments 嘅 raw response 帶病人資料（clinicPatient / visitReasons /
 * diagnosis / createdBy...）— **只准**留空檔計算需要嘅嘢：
 *   - practitionerOpenSchs[]：開診時段（startTime/endTime）
 *   - appointments[]：佔用時段（startTime/endTime）→ 算 bookedCount
 * 其餘全部 drop。raw response 永不入 log 永不落 disk（鐵律）—
 * 呢個 function 係落地前唯一嘅過濾口，sanitize 後嘅 object 先可以入 DB。
 *
 * 白名單手法（同 provider-roster sanitize.ts 一樣）：逐欄 pickup，唔係剷黑名單。
 */

export interface SanitizedOpenSch {
  startTime: string; // "HH:mm"
  endTime: string;   // "HH:mm"
}

export interface SanitizedAppointment {
  startTime: string;
  endTime: string;
}

export interface SanitizedOverview {
  openSchs: SanitizedOpenSch[];
  appointments: SanitizedAppointment[];
}

function toHHmm(v: unknown): string | null {
  const s = String(v ?? "").trim();
  // 收 "HH:mm" / "HH:mm:ss" / ISO 時間戳（提取 HH:mm）
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  m = new Date(s).toISOString().match(/T(\d{2}):(\d{2})/);
  if (m && !isNaN(new Date(s).getTime())) return `${m[1]}:${m[2]}`;
  return null;
}

interface OverviewRawLike {
  practitionerOpenSchs?: unknown;
  appointments?: unknown;
}

/**
 * 白名單 pickup：raw overview → 只留開診時段 + 佔用時段。
 * 任何 PII 欄位（clinicPatient/visitReasons/diagnosis/createdBy/...）喺呢度天然被 drop
 * （根本唔讀佢哋）。
 */
export function sanitizeOverview(raw: OverviewRawLike): SanitizedOverview {
  const openSchs: SanitizedOpenSch[] = [];
  for (const sch of Array.isArray(raw?.practitionerOpenSchs) ? raw.practitionerOpenSchs : []) {
    const st = toHHmm(sch?.startTime ?? sch?.start);
    const en = toHHmm(sch?.endTime ?? sch?.end);
    if (st && en && st !== en) openSchs.push({ startTime: st, endTime: en });
  }

  const appointments: SanitizedAppointment[] = [];
  for (const appt of Array.isArray(raw?.appointments) ? raw.appointments : []) {
    const st = toHHmm(appt?.startTime ?? appt?.start);
    const en = toHHmm(appt?.endTime ?? appt?.end);
    if (st && en && st !== en) appointments.push({ startTime: st, endTime: en });
  }

  return { openSchs, appointments };
}

// ── PII 洩漏斷言（sanitized output 落地前再兜一次底） ────────────────────

const PII_KEYS_STRICT = [
  "clinicPatient",
  "personalIdentifier",
  "medicalHistory",
  "drugHistory",
  "phoneNum",
  "phoneList",
  "dateOfBirth",
  "diagnosis",
  "address",
  "email",
  "fullName",
  "emergencyContact",
  "bloodType",
  "occupation",
  "visitReasons",
  "createdBy",
  "remarks",
];

/** 落地前 assert：sanitized object 絕唔可含任何 PII key（defence in depth）。 */
export function assertNoPii(obj: unknown): void {
  const json = JSON.stringify(obj);
  for (const leak of PII_KEYS_STRICT) {
    if (json.includes(leak)) throw new Error(`PII 洩漏：${leak}`);
  }
}
