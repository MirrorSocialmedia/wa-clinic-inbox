/**
 * booking-ui-contract — workforce 寫入 + patient-context 契約測試（booking-ui MD §1，零 DB 可跑）
 *
 * 斷言：
 *  1. FIXTURE ANCHOR（sha256 — drift 即紅）：
 *     - test/fixtures/external-v1-dictionaries.json
 *     - test/fixtures/external-v1-patient-lookup.json
 *     - test/fixtures/external-v1-appointments.json
 *     - src/lib/phone-hash.ts（★ 兩 repo byte-identical 錨 — clinic-workforce-mvp @ 8e89c42a
 *       同名檔，改邊邊都要先改呢度）
 *  2. PHONE-HASH VECTOR：anchor key 下 normalize + HMAC 決定性（CI hash 驗證 life-saver，
 *     同 clinic-workforce-mvp 共用 key 時同 phone → 同 hash）
 *  3. MOCK CONTRACT（WORKFORCE_MOCK=1 決定性 runtime）：
 *     - dictionaries / patient-lookup / appointments parse + PII strip（raw phone 零出现）
 *     - create 冪等（同 idempotencyKey → 同 apricotApptId）
 *     - 409 SLOT_TAKEN / 422 NEW_PATIENT_DISABLED / 503 WRITE_DISABLED 分支
 *     - status 白名單 102/-7（其他 400）/ remove / reschedule 決定性
 *  4. defaultVisitReasonCode()：env 空 = null / 有值 = 原樣
 *
 * 用法（repo root）：pnpm e2e:booking-ui-contract
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ★ 契約 anchors（改 fixture / phone-hash 都要先改呢度）
const ANCHORS = {
  "test/fixtures/external-v1-dictionaries.json":
    "6fffcc3f9ea091555345bd0efd073989750cc98c6b7197ef18baabe0a6d42e98",
  "test/fixtures/external-v1-patient-lookup.json":
    "a5a62baa1b3094394fdc1f009c8798219d55aa2f41e4c1e236517588bb19b07e",
  "test/fixtures/external-v1-appointments.json":
    "67733429f3422dba28a201878a33ce971e5de138e65212c8535e0e34d8629065",
  "src/lib/phone-hash.ts":
    "06f2ac3d3032e3bc003e1830bccf7d2b0dd9519452e3a8136059fba69b5931bb",
};

// ★ phone-hash 固定 test key（64 hex）— fixture byPhoneHash key 用佢派生，同 .env 解耦
const ANCHOR_HASH_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// HMAC-SHA256(anchor key, "91234567") — 上線同 workforce 共用真 key 時 vector 變，anchor 照樣驗 file byte-identity
const ANCHOR_HASH_OF_91234567 = "0016ac6d13b017afee7eea85bfe9e987cc6e73fe921abb9bf99bd9a5a683b2c1";

// mock env（必喺 import client 前 set — client 讀 env 係 call time，phone-hash 係 call time）
process.env.WORKFORCE_MOCK = "1";
process.env.PHONE_HASH_KEY = ANCHOR_HASH_KEY;
delete process.env.BOOKING_DEFAULT_VISIT_REASON_CODE;
delete process.env.WORKFORCE_MOCK_WRITE_DISABLED;
delete process.env.WORKFORCE_MOCK_NEW_PATIENT_ON;

const SLOT_TAKEN_FLAG = path.resolve(process.cwd(), ".dev/workforce-mock-slot-taken.json");

let WorkforceApiError: typeof import("../src/lib/workforce/client").WorkforceApiError;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  // ── 1. FIXTURE / SOURCE ANCHORS ──────────────────────────────────────────
  console.log("\n[1] anchors（sha256）");
  for (const [rel, expected] of Object.entries(ANCHORS)) {
    const abs = path.resolve(__dirname, "..", rel);
    let sha = "";
    try {
      sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
    } catch (e) {
      check(`read ${rel}`, false, e instanceof Error ? e.message : String(e));
      continue;
    }
    check(`${path.basename(rel)} = ${expected.slice(0, 16)}…`, sha === expected, `actual=${sha}`);
  }

  // ── 2. PHONE-HASH VECTOR ─────────────────────────────────────────────────
  console.log("\n[2] phone-hash vector");
  const { normalizePhone, phoneHash } = await import("../src/lib/phone-hash");
  check("normalizePhone('85291234567') = 91234567", normalizePhone("85291234567") === "91234567");
  check("normalizePhone('+852 9123 4567') = 91234567", normalizePhone("+852 9123 4567") === "91234567");
  check(
    "phoneHash('85291234567') = anchor vector",
    phoneHash("85291234567") === ANCHOR_HASH_OF_91234567,
    `actual=${phoneHash("85291234567")}`,
  );

  // ── 3. MOCK CONTRACT ─────────────────────────────────────────────────────
  console.log("\n[3] mock contract（WORKFORCE_MOCK=1）");
  const client = await import("../src/lib/workforce/client");
  WorkforceApiError = client.WorkforceApiError;
  const {
    fetchDictionaries,
    lookupPatient,
    fetchAppointments,
    createBooking,
    updateBookingStatus,
    removeBooking,
    rescheduleBooking,
    defaultVisitReasonCode,
    clearDictionariesCache,
  } = client;

  // 3a. dictionaries
  const vr = await fetchDictionaries("VISIT_REASON");
  check("dictionaries VISIT_REASON: 2 items (0010/0021)", vr.items.length === 2 && vr.items.map((i) => i.code).join(",") === "0010,0021");
  const bt = await fetchDictionaries("BOOKING_TYPE");
  check("dictionaries BOOKING_TYPE: 1 item", bt.items.length === 1);
  // cache：再撳一次 → 同一 object（1h memory cache 生效）
  const vr2 = await fetchDictionaries("VISIT_REASON");
  check("dictionaries 1h cache（同 call 回同 object）", vr2 === vr);
  clearDictionariesCache();

  // 3b. patient-lookup
  const lookup = await lookupPatient(ANCHOR_HASH_OF_91234567);
  check("patient-lookup: 1 match (mock-pat-0001)", lookup.matches.length === 1 && lookup.matches[0].patientApricotId === "mock-pat-0001");
  check("patient-lookup: lastVisit shape", lookup.matches[0].lastVisit?.date === "2026-07-15");
  check("patient-lookup PII strip（零 raw phone）", !JSON.stringify(lookup).includes("91234567"));
  await assertApiError("patient-lookup bad hash → 400", async () => lookupPatient("nothex"), 400);
  const unknownLookup = await lookupPatient("f".repeat(64));
  check("patient-lookup unknown hash → 空 matches（唔係 error）", unknownLookup.matches.length === 0);

  // 3c. appointments
  const apptsAll = await fetchAppointments(ANCHOR_HASH_OF_91234567, "2026-01-01", "2026-12-31");
  check("appointments: 3 rows（0/102/-7 三態）", apptsAll.appointments.length === 3);
  const apptsSept = await fetchAppointments(ANCHOR_HASH_OF_91234567, "2026-09-01", "2026-09-10");
  check("appointments: 日期窗口過濾（9/1-9/10 = 1 行）", apptsSept.appointments.length === 1 && apptsSept.appointments[0].apricotApptId === "mock-appt-fix-0001");
  check("appointments PII strip（零 raw phone）", !JSON.stringify(apptsAll).includes("91234567"));

  // 3d. create — 冪等 + 分支
  const idemKey = "wa-inbox-contract-test-001";
  const mkCreateBody = (patient: { patientApricotId: string } | { name: string; phone: string }) => ({
    idempotencyKey: idemKey,
    clinicCode: "TKW",
    providerApricotId: "mock-pract-tkw-1",
    date: "2026-09-02",
    start: "10:00",
    durationMin: 30,
    visitReasonId: "vr-0010",
    patient,
  });
  const c1 = await createBooking(mkCreateBody({ patientApricotId: "mock-pat-0001" }));
  const c2 = await createBooking(mkCreateBody({ patientApricotId: "mock-pat-0001" }));
  check("create: 200 shape（apricotApptId + bookingStatus 0）", typeof c1.apricotApptId === "string" && c1.bookingStatus === 0);
  check("create: 冪等（同 idempotencyKey → 同 apricotApptId）", c1.apricotApptId === c2.apricotApptId);
  check("create: 舊客 patientApricotId 透傳", c1.patientApricotId === "mock-pat-0001");
  check("create PII strip（零 raw phone）", !JSON.stringify(c1).includes("91234567"));

  // 409 SLOT_TAKEN（flag file → throw → 清理）
  mkdirSync(path.dirname(SLOT_TAKEN_FLAG), { recursive: true });
  writeFileSync(
    SLOT_TAKEN_FLAG,
    JSON.stringify([{ clinicCode: "TKW", providerApricotId: "mock-pract-tkw-1", date: "2026-09-02", start: "10:00" }])
  );
  await assertApiError("create: 409 SLOT_TAKEN", () => createBooking(mkCreateBody({ patientApricotId: "mock-pat-0001" })), 409, "SLOT_TAKEN");
  rmSync(SLOT_TAKEN_FLAG, { force: true });
  const c3 = await createBooking(mkCreateBody({ patientApricotId: "mock-pat-0001" }));
  check("create: flag 清理後恢復 200", c3.apricotApptId === c1.apricotApptId);

  // 422 NEW_PATIENT_DISABLED（Stage 1 預設 off）
  await assertApiError(
    "create: 新客 body → 422 NEW_PATIENT_DISABLED",
    () => createBooking(mkCreateBody({ name: "測試新客", phone: "85299998888" })),
    422,
    "NEW_PATIENT_DISABLED"
  );
  // 503 WRITE_DISABLED
  process.env.WORKFORCE_MOCK_WRITE_DISABLED = "1";
  await assertApiError("create: 503 WRITE_DISABLED", () => createBooking(mkCreateBody({ patientApricotId: "mock-pat-0001" })), 503, "WRITE_DISABLED");
  delete process.env.WORKFORCE_MOCK_WRITE_DISABLED;

  // 3e. status / remove / reschedule
  const s1 = await updateBookingStatus(c1.apricotApptId, 102, { clinicCode: "TKW", date: "2026-09-02" });
  check("status 102: 200 shape", s1.bookingStatus === 102 && s1.dayRefreshed === true);
  const s2 = await updateBookingStatus(c1.apricotApptId, -7, { clinicCode: "TKW", date: "2026-09-02" });
  check("status -7: 200 shape", s2.bookingStatus === -7);
  await assertApiError("status 白名單外（5）→ 400", async () => {
    // client 類型只收 102|-7 — 直接打 mock 驗 workforce 端白名單
    await client.wfSendForTest("PUT", `/api/external/v1/bookings/${c1.apricotApptId}/status`, { status: "5", date: "2026-09-02", clinicCode: "TKW" });
  }, 400);
  const rm = await removeBooking(c1.apricotApptId, { clinicCode: "TKW", date: "2026-09-02" });
  check("remove: 200（removed=true）", rm.removed === true);

  const r1 = await rescheduleBooking(c1.apricotApptId, {
    clinicCode: "TKW",
    providerApricotId: "mock-pract-tkw-1",
    date: "2026-09-03",
    start: "11:00",
    durationMin: 30,
    oldDate: "2026-09-02",
    patient: { patientApricotId: "mock-pat-0001" },
  });
  const r2 = await rescheduleBooking(c1.apricotApptId, {
    clinicCode: "TKW",
    providerApricotId: "mock-pract-tkw-1",
    date: "2026-09-03",
    start: "11:00",
    durationMin: 30,
    oldDate: "2026-09-02",
    patient: { patientApricotId: "mock-pat-0001" },
  });
  check("reschedule: oldApptId 透傳 + newApptId 決定性", r1.oldApptId === c1.apricotApptId && r1.newApptId === r2.newApptId && r1.newApptId !== c1.apricotApptId);
  writeFileSync(
    SLOT_TAKEN_FLAG,
    JSON.stringify([{ clinicCode: "TKW", providerApricotId: "mock-pract-tkw-1", date: "2026-09-04", start: "09:00" }])
  );
  await assertApiError(
    "reschedule: 新時段撞 → 409 SLOT_TAKEN",
    () =>
      rescheduleBooking(c1.apricotApptId, {
        clinicCode: "TKW",
        providerApricotId: "mock-pract-tkw-1",
        date: "2026-09-04",
        start: "09:00",
        durationMin: 30,
        oldDate: "2026-09-02",
        patient: { patientApricotId: "mock-pat-0001" },
      }),
    409,
    "SLOT_TAKEN"
  );
  rmSync(SLOT_TAKEN_FLAG, { force: true });

  // 3f. defaultVisitReasonCode
  check("defaultVisitReasonCode: env 空 → null", defaultVisitReasonCode() === null);
  process.env.BOOKING_DEFAULT_VISIT_REASON_CODE = "0021";
  check("defaultVisitReasonCode: env=0021 → 0021", defaultVisitReasonCode() === "0021");
  delete process.env.BOOKING_DEFAULT_VISIT_REASON_CODE;

  // ── 結果 ─────────────────────────────────────────────────────────────────
  if (failures > 0) {
    console.error(`\nBOOKING-UI-CONTRACT FAILED: ${failures} 項 fail`);
    process.exit(1);
  }
  console.log("\nBOOKING-UI-CONTRACT PASS ✓");
  process.exit(0); // ★ cwi-refresh-20260831：同上 — import 鏈含 redis handle，成功路徑顯式 exit
}

async function assertApiError(name: string, fn: () => Promise<unknown>, status: number, code?: string): Promise<void> {
  try {
    await fn();
    check(name, false, `expected WorkforceApiError(${status}), got success`);
  } catch (e) {
    const ok = e instanceof WorkforceApiError && e.status === status && (!code || e.code === code);
    check(name, ok, ok ? "" : `actual=${e instanceof WorkforceApiError ? `${e.status} ${e.code ?? ""}` : e instanceof Error ? e.message : String(e)}`);
  }
}

main().catch((e) => {
  console.error("BOOKING-UI-CONTRACT ERROR:", e);
  process.exit(1);
});
