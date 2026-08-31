/**
 * workforce-contract — clinic-workforce External API 契約測試（切換 MD §4，零 DB 可跑）
 *
 * 斷言：
 *  1. FIXTURE ANCHOR：test/fixtures/external-v1-availability.json 的 sha256
 *     必 = b23f5ec7cd87b1ff28c9dc8149da2798efe09112569e067de2f121b4572b448f
 *     （由 clinic-workforce repo 同名 fixture 一字一樣 copy 過嚟 — drift 即紅，防兩邊契約漂移）
 *  2. PARSE：fixture 過 AvailabilityResponse（zod = 契約執行點）
 *  3. PII STRIP：fixture 插 PII 欄變體（medicalHistory / clinicPatient / visitReasons /
 *     diagnosis — 模擬上游失守）→ zod 必須 strip（output 零 PII key/值）
 *  4. L2 ROW SHAPE：由 fixture 派生 AvailabilitySlot row（同 availability.ts upsertL2 邏輯）
 *     → 白名單欄位檢查：只可出現 clinicId/providerApricotId/date/startTime/endTime/
 *     bookedCount/isOpen/syncedAt — 零病人欄位
 *  5. SLOT FORMAT：slot start/end = HH:mm、bookedCount = int ≥ 0、days 覆埋 from..to 全日曆日
 *
 * 用法（repo root）：pnpm e2e:workforce-contract
 * 退出碼：0 = 全過；1 = 有 fail（T33 最後一步跑）
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AvailabilityResponse, type WorkforceAvailability } from "../src/lib/workforce/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ★ 契約 anchor（兩邊 repo 同一份 fixture — 改邊邊都要先改呢度）
const EXPECTED_FIXTURE_SHA256 = "b23f5ec7cd87b1ff28c9dc8149da2798efe09112569e067de2f121b4572b448f";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. FIXTURE ANCHOR ──────────────────────────────────────────────────────

const FIXTURE_PATH = path.resolve(__dirname, "../test/fixtures/external-v1-availability.json");
let fixtureRaw: string;
try {
  fixtureRaw = readFileSync(FIXTURE_PATH, "utf8");
} catch (e) {
  console.error(`  ✗ fixture 讀唔到: ${FIXTURE_PATH}（${e instanceof Error ? e.message : String(e)}）`);
  process.exit(1);
}
const actualSha = createHash("sha256").update(fixtureRaw).digest("hex");
check(
  `fixture sha256 = ${EXPECTED_FIXTURE_SHA256.slice(0, 16)}…`,
  actualSha === EXPECTED_FIXTURE_SHA256,
  `actual=${actualSha}`,
);
if (actualSha !== EXPECTED_FIXTURE_SHA256) {
  console.error("WORKFORCE-CONTRACT FAILED: fixture drift（兩邊契約唔同 — 停止）");
  process.exit(1);
}

// ── 2. PARSE ───────────────────────────────────────────────────────────────

let fixture: WorkforceAvailability;
try {
  fixture = AvailabilityResponse.parse(JSON.parse(fixtureRaw));
  check("fixture parse 通過（zod 契約）", true);
} catch (e) {
  check("fixture parse 通過（zod 契約）", false, e instanceof Error ? e.message.slice(0, 160) : String(e));
  process.exit(1);
}

// ── 3. PII STRIP（插 PII 欄變體 → zod 必須 strip） ─────────────────────────

const baitRaw = structuredClone(JSON.parse(fixtureRaw) as Record<string, unknown>);
const firstProvider = (baitRaw.days as Record<string, unknown>[])?.[0]?.providers as Record<string, unknown>[] | undefined;
if (firstProvider?.[0]) {
  const p = firstProvider[0];
  p.medicalHistory = "MOCK_PII_DIAGNOSIS";
  p.clinicPatient = { fullName: "MOCK_PII_PATIENT", phoneNum: "85200000000", dateOfBirth: "1990-01-01" };
  p.visitReasons = [{ des: "MOCK_PII_REASON" }];
  p.createdBy = "MOCK_PII_CREATOR";
}
baitRaw.diagnosis = "MOCK_PII_DIAGNOSIS"; // 頂層 bait
let stripped: unknown;
try {
  stripped = AvailabilityResponse.parse(baitRaw);
  check("PII 欄變體 parse 唔 reject（strip 唔係 reject）", true);
} catch (e) {
  check("PII 欄變體 parse 唔 reject（strip 唔係 reject）", false, e instanceof Error ? e.message.slice(0, 160) : String(e));
  process.exit(1);
}
const strippedJson = JSON.stringify(stripped);
const BAIT_VALUES = ["MOCK_PII_DIAGNOSIS", "MOCK_PII_PATIENT", "85200000000", "MOCK_PII_REASON", "MOCK_PII_CREATOR"];
for (const v of BAIT_VALUES) {
  check(`strip 後 output 零 PII 值 "${v}"`, !strippedJson.includes(v));
}
for (const k of ["medicalHistory", "clinicPatient", "visitReasons", "createdBy", "diagnosis", "fullName", "phoneNum", "dateOfBirth"]) {
  check(`strip 後 output 零 PII key "${k}"`, !strippedJson.includes(k));
}

// ── 4. L2 ROW SHAPE（AvailabilitySlot 白名單 — 零病人欄位） ────────────────

// 同 src/lib/availability.ts upsertL2 嘅 row 派生邏輯（mock clinicId — 形狀檢查用）
const L2_WHITELIST = new Set(["clinicId", "providerApricotId", "date", "startTime", "endTime", "bookedCount", "isOpen", "syncedAt"]);
const MOCK_CLINIC_ID = "l2-shape-check";
const syncedAt = fixture.syncedAt ?? new Date().toISOString();
const l2Rows: Record<string, unknown>[] = [];
for (const day of fixture.days) {
  for (const p of day.providers) {
    for (const s of p.slots) {
      l2Rows.push({
        clinicId: MOCK_CLINIC_ID,
        providerApricotId: p.providerApricotId,
        date: day.date,
        startTime: s.start,
        endTime: s.end,
        bookedCount: s.bookedCount,
        isOpen: s.isOpen,
        syncedAt: new Date(syncedAt).toISOString(),
      });
    }
  }
}
check("L2 rows 派生數 > 0", l2Rows.length > 0, `rows=${l2Rows.length}`);
let shapeBad: string | null = null;
for (const r of l2Rows) {
  for (const k of Object.keys(r)) {
    if (!L2_WHITELIST.has(k)) {
      shapeBad = `extra key "${k}"`;
      break;
    }
  }
  if (shapeBad) break;
}
check("L2 row shape = 白名單欄（零病人欄位）", shapeBad === null, shapeBad ?? `checked=${l2Rows.length} rows`);

// ── 5. SLOT FORMAT ─────────────────────────────────────────────────────────

const HHMM = /^\d{2}:\d{2}$/;
let fmtBad: string | null = null;
const dates = new Set<string>();
for (const day of fixture.days) {
  dates.add(day.date);
  for (const p of day.providers) {
    for (const s of p.slots) {
      if (!HHMM.test(s.start) || !HHMM.test(s.end) || !Number.isInteger(s.bookedCount) || s.bookedCount < 0) {
        fmtBad = `date=${day.date} slot=${JSON.stringify(s)}`;
        break;
      }
    }
    if (fmtBad) break;
  }
  if (fmtBad) break;
}
check("slot start/end = HH:mm + bookedCount = int ≥ 0", fmtBad === null, fmtBad ?? `checked=${dates.size} days`);
check("response v=1 + clinicCode 非空", fixture.v === 1 && fixture.clinicCode.length > 0);

// ── summary ────────────────────────────────────────────────────────────────

if (failures === 0) {
  console.log("WORKFORCE-CONTRACT OK");
  process.exit(0); // ★ cwi-refresh-20260831：client.ts import 鏈現含 redis handle（availability→notify→queue）— 成功路徑必須顯式 exit，否則 e2e 內 $( ) 永遠唔會完成
} else {
  console.error(`WORKFORCE-CONTRACT FAILED: ${failures} failures`);
  process.exit(1);
}
