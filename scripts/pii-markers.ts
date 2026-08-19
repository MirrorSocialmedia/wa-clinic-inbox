/**
 * pii-markers — PII marker 定義 + 匹配（pii-scan.ts 三個層共用；亦可獨立單測）
 *
 * ★ T33 flaky 修復（2026-08-19）：
 *   之前用 bare substring（content.includes("ssn")），Prisma cuid 嘅 36^28 隨機字
 *   會撞 3 字母 substring（實例：cmszge4o201p83e1lvkeu[ssn]f）→ 測試門非確定性失敗。
 *
 * 修復原則（逐個 pattern review）：
 * - 字段名 → \b word boundary 精確 token（唔命中 cuid / base64 / 更長 identifier 內部）
 * - SSN → 完整美國格式 \b\d{3}-\d{2}-\d{4}\b + JSON key 偵測 ["']ssn["']\s*:
 *         （廢棄 bare "ssn" 三字 substring）
 * - 身份證號 → 完整 18 位格式（17 位數字 + 數字或 X/x）
 * - email → 完整 email 格式 regex
 * - phoneNum → 帶引號精確 match（避免命中自家 metadata key `phoneNumberId`）
 * - deterministic bait → 維持 exact match（100% 受控定值，唔會隨機撞，唔使加 boundary）
 */

export type PiiMarker = { label: string; re: RegExp };

// 1) 字段名 markers（word boundary 精確 token，case-insensitive）
const PII_FIELD_NAME_WORDS = [
  "clinicPatient",
  "personalIdentifier",
  "medicalHistory",
  "drugHistory",
  "phoneList",
  "dateOfBirth",
  "diagnosis",
  "emergencyContact",
  "bloodType",
  "occupation",
  "visitReasons",
  "createdBy",
  "vcard",
  "idCard",
];
// 註：「ssn」故意唔喺 word 列表 — 3 字母太短，改用下方完整格式 + JSON key 偵測

export const PII_MARKERS: PiiMarker[] = [
  ...PII_FIELD_NAME_WORDS.map((w) => ({ label: w, re: new RegExp(`\\b${w}\\b`, "i") })),
  // SSN（a）完整美國格式 ddd-dd-dddd
  { label: "ssn (US format \\d{3}-\\d{2}-\\d{4})", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  // SSN（b）JSON key 偵測：["']ssn["']\s*: — 只命中當 JSON key 嘅 ssn
  { label: 'ssn (JSON key ["\']ssn["\']\\s*:)', re: /["']ssn["']\s*:/i },
  // 身份證號：完整 18 位（17 位數字 + 數字或 X/x）
  { label: "idCard (18-digit format)", re: /\b\d{17}[\dXx]\b/ },
  // email：完整格式
  { label: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // ★ phoneNum 要精確匹配（帶引號）— 避免 substring 誤中我哋自己嘅 metadata key `phoneNumberId`
  { label: '"phoneNum"', re: /"phoneNum"/ },
];

// 2) 決定性 bait（mock fixture 故意埋入 — 落地必須 0 hit）
//    exact match：受控定值，唔會隨機撞（正正係 bait 嘅設計目的）
export const PII_BAIT_STRINGS = [
  "MOCK_PII_PATIENT",
  "MOCK_PII_REASON",
  "MOCK_PII_DIAGNOSIS",
  "MOCK_PII_CREATOR",
  "85200000000",
  "1990-01-01",
];

// 3) schema scan 用（欄位名 exact/suffix 匹配 — 欄位名清單本身係確定性，唔係 log/DB 內容）
export const PII_FIELD_NAMES_SCHEMA = [...PII_FIELD_NAME_WORDS, "ssn", "phoneNum"];

/** 對一段文本（JSON dump / log content）跑全部 marker，返命中 label 列表 */
export function matchPiiMarkers(text: string): string[] {
  const hits: string[] = [];
  for (const m of PII_MARKERS) if (m.re.test(text)) hits.push(m.label);
  for (const s of PII_BAIT_STRINGS) if (text.includes(s)) hits.push(s);
  return hits;
}
