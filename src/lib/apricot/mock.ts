/**
 * Apricot mock（APRICOT_MOCK=1）— 決定性 slot fixture
 *
 * 用途：沙箱冇真 Apricot bot 帳號 — E2E 用決定性 fixture 行晒 adapter 全鏈
 * （sanitize 白名單 → slot 計算 → DB）。真碼（client.ts）照完整 —
 * APRICOT_MOCK 只係將「HTTP response」換成 fixture，其餘 pipeline 同一條。
 *
 * Fixture 規則（純函數 — 同輸入永遠同輸出）：
 * - 3 店 × 該店醫生 × 窗口內每一日（未來 7 日保證有 slot；實際生成到 +30 日）
 * - 開診時段：10:00-13:00 + 14:00-17:00（30 分鐘 slot 粒度）
 * - 決定性閉诊日：hash(clinic, doctor, date) % 7 == 0 → 該日無開診（0 slot）
 * - 決定性滿位：hash(clinic, doctor, date, slot) % 4 == 0 → 該 slot 有 1 個預約
 * - ★ PII bait：raw fixture 恆定帶 clinicPatient / visitReasons[].des / diagnosis /
 *   createdBy（MOCK_PII_* 字串）— 經 sanitize 落地後 DB + log 必須 0 hit（T33 斷言）。
 *
 * 「flow 中途變滿」：E2E 寫 `.dev/apricot-mock-fill.json`（clinicCode/providerApricotId/
 * date/startTime），之後嘅 sync 會將該 slot 標滿（模擬病人揀完医生日期之後、
 * 撳 Complete 之前，該時段喺 Apricot 被人 book 咗）。
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";

/** 決定性 hash（djb2）— 同 input 永遠同 output，跨 process 一致。 */
export function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

const FILL_FLAG_PATH = path.resolve(process.cwd(), ".dev/apricot-mock-fill.json");

interface FillFlag {
  clinicCode: string;
  providerApricotId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
}

function readFillFlags(): FillFlag[] {
  try {
    const raw = readFileSync(FILL_FLAG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter(
      (f) =>
        f &&
        typeof f.clinicCode === "string" &&
        typeof f.providerApricotId === "string" &&
        typeof f.date === "string" &&
        typeof f.startTime === "string"
    );
  } catch {
    return [];
  }
}

/** 30 分鐘 slot 粒度（一個 slot = 一個病人容量 — bookedCount>=1 = 滿） */
export const SLOT_MINUTES = 30;

function hhmmAdd(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 決定性 mock overview raw 形狀（同真 Apricot response 對齊 + PII bait 欄）。 */
export interface MockDayRaw {
  practitionerOpenSchs: { startTime: string; endTime: string }[];
  appointments: Record<string, unknown>[];
  latestPatient: Record<string, unknown>; // PII bait（raw 真實含有病人資料）
}

/**
 * 決定性 mock overview response（shape 跟真 Apricot getOverviewAppointments 對齊：
 * practitionerOpenSchs + appointments — 另加 mock 專屬 PII bait 欄）。
 *
 * @returns SanitizedOverview 之外嘅 RAW shape — 由 caller 過 sanitizeOverview()。
 */
export function mockOverviewRaw(opts: {
  clinicCode: string;
  providerApricotId: string;
  date: string; // YYYY-MM-DD
}): MockDayRaw {
  const { clinicCode, providerApricotId, date } = opts;
  const dayHash = djb2(`${clinicCode}|${providerApricotId}|${date}`);

  // 決定性閉诊日（~1/7 日）
  if (dayHash % 7 === 0) {
    return {
      practitionerOpenSchs: [],
      appointments: [],
      // PII bait（raw response 真實含有病人資料 — sanitize 必須 drop）
      latestPatient: {
        clinicPatient: {
          fullName: "MOCK_PII_PATIENT",
          phoneNum: "85200000000",
          dateOfBirth: "1990-01-01",
        },
        diagnosis: "MOCK_PII_DIAGNOSIS",
        visitReasons: [{ des: "MOCK_PII_REASON" }],
        createdBy: "MOCK_PII_CREATOR",
      },
    };
  }

  const openSchs = [
    { startTime: "10:00", endTime: "13:00" },
    { startTime: "14:00", endTime: "17:00" },
  ];

  const fillFlags = readFillFlags().filter(
    (f) => f.clinicCode === clinicCode && f.providerApricotId === providerApricotId && f.date === date
  );

  const appointments: Record<string, unknown>[] = [];
  for (const sch of openSchs) {
    let t = sch.startTime;
    while (t < sch.endTime) {
      const t2 = hhmmAdd(t, SLOT_MINUTES);
      const filledByHash = djb2(`${clinicCode}|${providerApricotId}|${date}|${t}`) % 4 === 0;
      const filledByFlag = fillFlags.some((f) => f.startTime === t);
      if (filledByHash || filledByFlag) {
        appointments.push({
          startTime: t,
          endTime: t2,
          // PII bait（真 response 嘅預約物件會帶病人 — 白名單只准留時間）
          clinicPatient: { fullName: "MOCK_PII_PATIENT", phoneNum: "85200000000" },
          visitReasons: [{ des: "MOCK_PII_REASON" }],
          diagnosis: "MOCK_PII_DIAGNOSIS",
          createdBy: "MOCK_PII_CREATOR",
        });
      }
      t = t2;
    }
  }

  return {
    practitionerOpenSchs: openSchs,
    appointments,
    // PII bait 恆定存在（即使無預約）— 確保每次日嘅 raw 都經 sanitize 過濾
    latestPatient: {
      clinicPatient: { fullName: "MOCK_PII_PATIENT", phoneNum: "85200000000" },
      diagnosis: "MOCK_PII_DIAGNOSIS",
      visitReasons: [{ des: "MOCK_PII_REASON" }],
      createdBy: "MOCK_PII_CREATOR",
    },
  };
}

/** E2E 用：寫 / 清 fill flag（「flow 中途變滿」場景）。 */
export function writeMockFillFlag(flags: FillFlag[]): void {
  mkdirSync(path.dirname(FILL_FLAG_PATH), { recursive: true });
  writeFileSync(FILL_FLAG_PATH, JSON.stringify(flags, null, 2));
}

export function clearMockFillFlag(): void {
  try {
    unlinkSync(FILL_FLAG_PATH);
  } catch {
    /* 唔存在就 skip */
  }
}
