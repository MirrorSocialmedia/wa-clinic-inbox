/**
 * pii-markers.test.ts — marker 真陽性 / 偽陽性 fixture（防改太鬆 / 防改太緊）
 *
 * 跑法：pnpm test:pii
 * 退出碼：0 = 全部符合預期；1 = 有 case 唔符合
 *
 * 背景（T33 flaky，2026-08-19）：bare "ssn" substring 命中 cuid
 * cmszge4o201p83e1lvkeu[ssn]f。呢個 test 鎖住兩邊：
 * - 真 PII（SSN 格式 / ssn JSON key / email / 字段名 / bait）→ 必須 catch
 * - 隨機數據（cuid / JWT / 時間戳 / npm version / 電話 metadata key）→ 必須 0 hit
 */
import { matchPiiMarkers } from "./pii-markers";

let failures = 0;

function expectHits(name: string, text: string, expected: string[]): void {
  const hits = matchPiiMarkers(text);
  const missing = expected.filter((e) => !hits.includes(e));
  const extra = hits.filter((h) => !expected.includes(h));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ✅ ${name}: hits=[${hits.join(", ")}]`);
  } else {
    failures++;
    console.error(`  ❌ ${name}`);
    console.error(`     text     = ${text}`);
    console.error(`     got      = [${hits.join(", ")}]`);
    if (missing.length) console.error(`     missing  = [${missing.join(", ")}]`);
    if (extra.length) console.error(`     unexpected = [${extra.join(", ")}]`);
  }
}

function expectClean(name: string, text: string): void {
  const hits = matchPiiMarkers(text);
  if (hits.length === 0) {
    console.log(`  ✅ ${name}: 0 hits`);
  } else {
    failures++;
    console.error(`  ❌ ${name}: 預期 0 hit，實得 [${hits.join(", ")}]`);
    console.error(`     text = ${text}`);
  }
}

console.log("── 真陽性（必須 catch 到）──");
// SSN 完整格式
expectHits("SSN 完整格式", "patient ssn is 123-45-6789 ok", ["ssn (US format \\d{3}-\\d{2}-\\d{4})"]);
// SSN JSON key（雙引號）
expectHits('SSN JSON key "ssn":', '{"ssn": "123-45-6789"}', [
  'ssn (JSON key ["\']ssn["\']\\s*:)',
  "ssn (US format \\d{3}-\\d{2}-\\d{4})",
]);
// SSN JSON key（單引號、無空格）
expectHits("SSN JSON key 'ssn':（單引號緊貼）", "{'ssn':'987-65-4321'}", [
  'ssn (JSON key ["\']ssn["\']\\s*:)',
  "ssn (US format \\d{3}-\\d{2}-\\d{4})",
]);
// 真 email
expectHits("真 email（bare）", "contact: john.doe+test@example.com", ["email"]);
expectHits("真 email（JSON value）", '{"email":"patient@example.com"}', ["email"]);
// 字段名（JSON key / bare log 文字）
expectHits("字段名 clinicPatient（JSON key）", '{"clinicPatient":{"fullName":"X"}}', ["clinicPatient"]);
expectHits("字段名 diagnosis（bare log 文字）", "adapter: strip diagnosis field", ["diagnosis"]);
expectHits("字段名 visitReasons + createdBy", '{"visitReasons":[],"createdBy":"X"}', ["visitReasons", "createdBy"]);
// phoneNum 帶引號精確
expectHits('phoneNum（帶引號）', '{"phoneNum":"85212345678"}', ['"phoneNum"']);
// 身份證 18 位（末位數字 / X）
expectHits("身份證 18 位（末位數字）", '{"idCard":"110101199003078515"}', ["idCard (18-digit format)", "idCard"]);
expectHits("身份證 18 位（末位 X）", "idCard=11010119900307851X", ["idCard (18-digit format)", "idCard"]);
// bait 決定性字符串
expectHits("bait MOCK_PII_PATIENT", "raw: MOCK_PII_PATIENT", ["MOCK_PII_PATIENT"]);
expectHits("bait 85200000000", "phone 85200000000", ["85200000000"]);
expectHits("bait 1990-01-01", "dob 1990-01-01", ["1990-01-01"]);

console.log("── 偽陽性（必須 0 hit）──");
// ★ 實戰撞擊行（T33 flaky 原案）：cuid 入面有 "ssn" substring
expectClean(
  "T33 原案 log line（cuid 含 ss n substring）",
  '{"time":"2026-08-19T02:09:24.803Z","app":"wa-clinic-inbox","clinic":"TKW","clinicId":"cmsycau8v00003esk5hw7esdc","conversationId":"cmszge4o201p83e1lvkeussnf","messageId":"cmszge4ov01pb3e1lpki4r0n1","draftId":"cmszge4ot01pa3e1lgkjo2h53","intent":"BOOKING_REQUEST","urgency":"LOW","replyWamid":"wamid.E2E_EXP_1787105220","msg":"ai: AUTO send queued (outbound chain; draft=SENT_AUTO)"}',
);
// server 側同一條 conversation 嘅 log line
expectClean(
  "T33 原案 server log line",
  '{"level":30,"time":"2026-08-19T02:09:24.895Z","app":"wa-clinic-inbox","conversationId":"cmszge4o201p83e1lvkeussnf","clinicId":"cmsycau8v00003esk5hw7esdc","messageId":"cmszge4rg000p3eo9qbe71vno","staffId":"cmsycaucg00033esk3r8c1yuy","msg":"flow send: queued interactive flow message"}',
);
// 隨機 cuid 撞 "ssn"（再造幾個）
expectClean("cuid 撞 ss n（abcssn...）", "id=cmabssn1x2y3z4a5b6c7d8e9f0g1");
expectClean("cuid 撞 ss n（...xssny...）", "token ref: h1xssnyq2w3e4r5t6y7u8i9o0p");
// JWT / base64url（flowToken 類）
expectClean("JWT base64url", "flowToken=eyJhbGciOiJIUzI1NiJ9.eyJjb252SWQiOiJjbXN6Z2U0b2IyMDFwODNlMWx2a2V1c3NuaCJ9.xssnabcdef123456");
// metadata key phoneNumberId（唔係 phoneNum）
expectClean("metadata key phoneNumberId", '{"phoneNumberId":"cmsycaudh00013esk8x2m9pqr","wamid":"wamid.E2E_EXP_1787105220"}');
// 時間戳 / 日期（唔係 SSN 格式）
expectClean("ISO 時間戳", "2026-08-19T02:09:24.803Z / 2026-08-19 02:09:24");
// 短日期（1990-01-02 — 唔係 bait 定值）
expectClean("普通日期 1990-01-02", "created 1990-01-02");
// 4-2-4 數字（唔係 SSN 格式）
expectClean("4-2-4 數字（唔係 SSN）", "ref 1234-56-7890");
// 17 位數字（少一位唔係身份證）
expectClean("17 位數字", "num 12345678901234567");
// npm version（@ 但唔係 email）
expectClean("npm version next@15.5.23", "next@15.5.23 is in the lockfile");
expectClean("npm version tsx@4.19.2", "tsx@4.19.2 resolved");
// wamid（. 分隔，無 @）
expectClean("wamid", "wamid.E2E_EXP_1787105220");
// 大寫 Ssn 獨立單詞（唔係 JSON key、唔係格式 — 任務要求：唔好 bare 三字）
expectClean("bare 單詞 ssn（非 key 非格式）", "ssn field was stripped by adapter");

console.log(failures === 0 ? "PII-MARKERS TEST OK: all fixtures pass" : `PII-MARKERS TEST FAILED: ${failures} case(s)`);
process.exit(failures === 0 ? 0 : 1);
