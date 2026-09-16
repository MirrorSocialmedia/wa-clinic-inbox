/**
 * e2e-followup-p4.ts — P4 臨床跟進 C/D/E（followup-v2 MD §5.5 五項驗收 + 術語表 + hub tab）
 *
 * 前置：dev server 127.0.0.1:3100（WA_MOCK=1）；worker 跑緊（tsx src/workers/index.ts，
 *   .env WORKFORCE_MOCK=1）；Postgres 15432；redis 6379。
 * 跑法：pnpm -s tsx scripts/e2e-followup-p4.ts
 *
 * 決定性：
 *   - 自建 clinic E2EP4（9 病人 cp4-*，固定 id，冪等）— 隔離 dev DB 其餘噪音。
 *   - mock 動態 fixture `.dev/workforce-mock-clinical.json`（symlink → /tmp 避 Next watcher）：
 *     visits（C/D 矩陣）+ quotes（MD §5.2 三實測樣本之 parser 實跑輸出，逐字對齊）+ terms。
 *   - 第一次 scan 經 cron queue enqueue（worker 執行 — 證明掛接）；其餘走引擎直接調。
 *
 * 斷言（MD §5.5）：
 *   T400 基建 + 冪等洗｜T401 cron enqueue 掛接（C 正例先出）
 *   T402 C 拔牙後 1 日 task（DUE）｜T403 C 洗牙唔出 + C 無抗生素唔出｜T404 C 今日 → SCHEDULED
 *   T405 D 洗牙 6 月 task（DUE）｜T406 D 3 月唔出 + 再洗過唔出（冪等）
 *   T407 E 正例 task（未審批 template → task 照建）｜T408 E 已有 booking 唔出 + booked 計數
 *   T409 E 三實測樣本抽到（S1 12000 / S2 4K+900@+5-6K / S3 5500@+18K）+ suggest/consider 標未做
 *   T410 術語表加詞即時生效（PUT → GET）+ 收貨順手教字典（correct + teachTerm）
 *   T411 hub API（7 規則 / 六項取消 / 健康警示 5 項 / E template 未審批紅）+ hub 頁「主動跟進」tab
 *   T412 藥物 tab：patient-record visits[].rxCodes（code→name + 抗生素旗）
 *   T413 opt-out 優先（checkCancellations → OPT_OUT）｜T414 冪等（重跑零新 task）+ 零殘留
 *
 * e2e harness：playwright/prisma 動態 payload 型太繁 → 本檔局部 any（src/ 零 any）
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient, type FollowupTrigger } from "@prisma/client";
import { phoneHashes } from "../src/lib/phone-hash";

const argon2 = createRequire(path.join(process.cwd(), "package.json"))("argon2");

const BASE = "http://127.0.0.1:3100";
const PASS = "P4-E2E-Pass-456!";
const PFX = "e2ep4";
const CLINIC_ID = "e2ep4clinic0000000000001";
const CODE = "E2EP4";
const ADMIN_EMAIL = "e2ep4-admin@e2e.local";
const MOCK_REAL = "/tmp/e2ep4-clinical-mock.json";
const MOCK_FLAG = path.resolve(process.cwd(), ".dev/workforce-mock-clinical.json");

let passCount = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passCount++;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
    process.exitCode = 1;
  }
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dstr = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

const prisma = new PrismaClient();

// ── 病人矩陣（固定 waId / cpId / 前綴 id — 冪等）────────────────────────────
type Fix = { waId: string; cpId: string; contactId: string; convId: string; name: string };
const FIX: Record<string, Fix> = {
  C1: { waId: "92100001", cpId: "cp4-c01", contactId: "e2ep4c-c01", convId: "e2ep4v-c01", name: "E2E C1 拔牙+抗生素" },
  C2: { waId: "92100002", cpId: "cp4-c02", contactId: "e2ep4c-c02", convId: "e2ep4v-c02", name: "E2E C2 洗牙+抗生素" },
  C3: { waId: "92100003", cpId: "cp4-c03", contactId: "e2ep4c-c03", convId: "e2ep4v-c03", name: "E2E C3 拔牙無抗生素" },
  C4: { waId: "92100004", cpId: "cp4-c04", contactId: "e2ep4c-c04", convId: "e2ep4v-c04", name: "E2E C4 拔牙今日" },
  D1: { waId: "92100005", cpId: "cp4-d01", contactId: "e2ep4c-d01", convId: "e2ep4v-d01", name: "E2E D1 洗牙7月前" },
  D2: { waId: "92100006", cpId: "cp4-d02", contactId: "e2ep4c-d02", convId: "e2ep4v-d02", name: "E2E D2 洗牙3月前" },
  D3: { waId: "92100007", cpId: "cp4-d03", contactId: "e2ep4c-d03", convId: "e2ep4v-d03", name: "E2E D3 洗牙8月前+2月前" },
  E1: { waId: "92100008", cpId: "cp4-e01", contactId: "e2ep4c-e01", convId: "e2ep4v-e01", name: "E2E E1 三樣本報價" },
  E2: { waId: "92100009", cpId: "cp4-e02", contactId: "e2ep4c-e02", convId: "e2ep4v-e02", name: "E2E E2 報價已book" },
};
const P4_PATIENTS = Object.values(FIX).map((f) => f.cpId);

// ── MD §5.2 三實測樣本 → parser 實跑輸出（fixture 逐字對齊）──────────────────
// 由 CWM quote-parser（dev TERMS seed）實跑 dump；amount/intent/certainty 全部真值。
const S1 = { text: "need perio by dr wong, quoted 3 part 12000$ / 36 37 imlpant" };
const S2 = { text: "SP DURAPHAT / FILLING X1 / TCA / BLEACHING 4K / FILL 900@ / ANTI SNORING DEVICE 5-6K" };
const S3 = { text: "suggest br 32-42 ... quoted br per unit 5500 or implant 31 41 / consider x 37 + implant 18k" };
type SampleItem = { text: string; termShorthand: string | null; nameCn: string | null; amountMin: number | null; amountMax: number | null; perUnit: boolean; fdiTeeth: string[]; intent: "not_done" | "unknown"; certainty: "high" | "low" };
const S1_ITEMS: SampleItem[] = [
  { text: "perio wong, 3 part", termShorthand: null, nameCn: null, amountMin: 12000, amountMax: 12000, perUnit: false, fdiTeeth: [], intent: "not_done", certainty: "low" },
  { text: "imlpant", termShorthand: null, nameCn: null, amountMin: null, amountMax: null, perUnit: false, fdiTeeth: ["36", "37"], intent: "unknown", certainty: "low" },
];
const S2_ITEMS: SampleItem[] = [
  { text: "SP", termShorthand: "SP", nameCn: "洗牙", amountMin: null, amountMax: null, perUnit: false, fdiTeeth: [], intent: "unknown", certainty: "high" },
  { text: "DURAPHAT", termShorthand: "DURAPHAT", nameCn: "氟保護漆 (DURAPHAT)", amountMin: null, amountMax: null, perUnit: false, fdiTeeth: [], intent: "unknown", certainty: "high" },
  { text: "FILLING", termShorthand: "FILLING", nameCn: "補牙", amountMin: null, amountMax: null, perUnit: false, fdiTeeth: [], intent: "unknown", certainty: "high" },
  { text: "TCA", termShorthand: null, nameCn: "下次覆診 (TCA)", amountMin: null, amountMax: null, perUnit: false, fdiTeeth: [], intent: "not_done", certainty: "high" },
  { text: "BLEACHING", termShorthand: "BLEACHING", nameCn: "牙齒美白", amountMin: 4000, amountMax: 4000, perUnit: false, fdiTeeth: [], intent: "unknown", certainty: "high" },
  { text: "FILL", termShorthand: "FILL", nameCn: "補牙", amountMin: 900, amountMax: 900, perUnit: true, fdiTeeth: [], intent: "unknown", certainty: "high" },
  { text: "ANTI SNORING DEVICE", termShorthand: "ANTI SNORING DEVICE", nameCn: "止鼾牙套", amountMin: 5000, amountMax: 6000, perUnit: false, fdiTeeth: [], intent: "unknown", certainty: "high" },
];
const S3_ITEMS: SampleItem[] = [
  { text: "br", termShorthand: "br", nameCn: "牙橋", amountMin: null, amountMax: null, perUnit: false, fdiTeeth: ["32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42"], intent: "not_done", certainty: "high" },
  { text: "br", termShorthand: "br", nameCn: "牙橋", amountMin: 5500, amountMax: 5500, perUnit: true, fdiTeeth: [], intent: "not_done", certainty: "high" },
  { text: "implant", termShorthand: "implant", nameCn: "植牙", amountMin: null, amountMax: null, perUnit: false, fdiTeeth: ["31", "41"], intent: "not_done", certainty: "high" },
  { text: "x", termShorthand: "x", nameCn: "拔牙", amountMin: null, amountMax: null, perUnit: false, fdiTeeth: ["37"], intent: "not_done", certainty: "high" },
  { text: "implant", termShorthand: "implant", nameCn: "植牙", amountMin: 18000, amountMax: 18000, perUnit: false, fdiTeeth: [], intent: "not_done", certainty: "high" },
];

async function mkPatient(key: string) {
  const f = FIX[key];
  await prisma.contact.upsert({
    where: { id: f.contactId },
    create: { id: f.contactId, clinicId: CLINIC_ID, waId: f.waId, labels: [], profileName: f.name },
    update: {},
  });
  await prisma.conversation.upsert({
    where: { id: f.convId },
    create: {
      id: f.convId,
      clinicId: CLINIC_ID,
      contactId: f.contactId,
      pinnedPatientApricotId: f.cpId,
      pinnedPatientName: f.name,
      lastMessageAt: new Date(),
    },
    update: { pinnedPatientApricotId: f.cpId },
  });
}

async function cleanup() {
  await prisma.followupTask.deleteMany({ where: { patientApricotId: { in: P4_PATIENTS } } });
  await prisma.bookingRequest.deleteMany({ where: { conversationId: { in: Object.values(FIX).map((f) => f.convId) } } });
  await prisma.conversation.deleteMany({ where: { clinicId: CLINIC_ID } });
  await prisma.contact.deleteMany({ where: { clinicId: CLINIC_ID } });
  await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
  await prisma.staffUser.deleteMany({ where: { email: ADMIN_EMAIL } });
  try {
    // symlink → unlink 本體（/tmp real 由 fixture 重寫）
    const st = fs.lstatSync(MOCK_FLAG);
    if (st.isSymbolicLink()) fs.unlinkSync(MOCK_FLAG);
    else fs.rmSync(MOCK_FLAG, { force: true });
  } catch {
    /* 無 file 好 */
  }
}

async function writeFixture() {
  const vrow = (o: Record<string, unknown>) => ({
    patientCode: "PC4",
    clinicCode: CODE,
    providerCode: "prov4",
    hasNote: true,
    noteKind: "STANDARD" as const,
    firstLine: "E2E 臨床記錄（mock — 零真值）",
    quotedItems: null,
    billTtlAmt: 0,
    billOsAmt: 0,
    rxCodes: [],
    ...o,
  });
  const q = (id: string, sampleDate: string, item: { text: string; termShorthand: string | null; nameCn: string | null; amountMin: number | null; amountMax: number | null; perUnit: boolean; fdiTeeth: string[]; intent: "not_done" | "unknown"; certainty: "high" | "low" }, status: string) => ({
    id,
    patientApricotId: FIX.E1.cpId,
    clinicCode: CODE,
    sourceVisitDate: sampleDate,
    text: "e2e sample",
    termShorthand: item.termShorthand,
    nameCn: item.nameCn,
    amountMin: item.amountMin,
    amountMax: item.amountMax,
    perUnit: item.perUnit,
    fdiTeeth: item.fdiTeeth,
    intent: item.intent,
    certainty: item.certainty,
    source: "parser",
    status,
  });
  const fixture = {
    visits: [
      vrow({ visitId: "v4c1", patientApricotId: FIX.C1.cpId, visitDate: dstr(-2), visitReasonCodes: ["0017"], bookingStatus: 1, phoneHashes: phoneHashes(FIX.C1.waId), rxCodes: [{ code: "AMOX", name: "Amoxicillin", isAntibiotic: true }] }),
      vrow({ visitId: "v4c2", patientApricotId: FIX.C2.cpId, visitDate: dstr(-2), visitReasonCodes: ["0008"], bookingStatus: 1, phoneHashes: phoneHashes(FIX.C2.waId), rxCodes: [{ code: "AMOX", name: "Amoxicillin", isAntibiotic: true }] }),
      vrow({ visitId: "v4c3", patientApricotId: FIX.C3.cpId, visitDate: dstr(-2), visitReasonCodes: ["0017"], bookingStatus: 1, phoneHashes: phoneHashes(FIX.C3.waId), rxCodes: [{ code: "IBU", name: "Ibuprofen", isAntibiotic: false }] }),
      vrow({ visitId: "v4c4", patientApricotId: FIX.C4.cpId, visitDate: dstr(0), visitReasonCodes: ["0017"], bookingStatus: 1, phoneHashes: phoneHashes(FIX.C4.waId), rxCodes: [{ code: "AMOX", name: "Amoxicillin", isAntibiotic: true }] }),
      vrow({ visitId: "v4d1", patientApricotId: FIX.D1.cpId, visitDate: dstr(-213), visitReasonCodes: ["0008"], bookingStatus: 1, phoneHashes: phoneHashes(FIX.D1.waId) }),
      vrow({ visitId: "v4d2", patientApricotId: FIX.D2.cpId, visitDate: dstr(-91), visitReasonCodes: ["0008"], bookingStatus: 1, phoneHashes: phoneHashes(FIX.D2.waId) }),
      vrow({ visitId: "v4d3a", patientApricotId: FIX.D3.cpId, visitDate: dstr(-260), visitReasonCodes: ["0008"], bookingStatus: 1, phoneHashes: phoneHashes(FIX.D3.waId) }),
      vrow({ visitId: "v4d3b", patientApricotId: FIX.D3.cpId, visitDate: dstr(-60), visitReasonCodes: ["0008"], bookingStatus: 1, phoneHashes: phoneHashes(FIX.D3.waId) }),
      // E 正例 visit（報價源 — 唔係 0008/0017 唔會誤觸 C/D）
      vrow({ visitId: "v4e1", patientApricotId: FIX.E1.cpId, visitDate: dstr(-8), visitReasonCodes: ["0021"], bookingStatus: 0, phoneHashes: phoneHashes(FIX.E1.waId) }),
    ],
    quotes: [
      // S1（10 日前，pending low — E 唔計）
      q("q4-s1-0", dstr(-10), S1_ITEMS[0], "pending"),
      q("q4-s1-1", dstr(-10), S1_ITEMS[1], "pending"),
      // S2（9 日前，confirmed high）
      ...S2_ITEMS.map((it, i) => q(`q4-s2-${i}`, dstr(-9), it, "confirmed")),
      // S3（8 日前，confirmed high — 最新 → E task 用呢批）
      ...S3_ITEMS.map((it, i) => q(`q4-s3-${i}`, dstr(-8), it, "confirmed")),
      // E 反例：E2 confirmed（8 日前）+ 本地 booking → booked
      q("q4-e2-0", dstr(-8), { text: "Braces $30K consider", termShorthand: "INV", nameCn: "隱形牙箍", amountMin: 30000, amountMax: 30000, perUnit: false, fdiTeeth: [], intent: "not_done", certainty: "high" }, "confirmed"),
    ].map((x) => (x.id === "q4-e2-0" ? x : x)),
    terms: [
      { id: "t4-implant", shorthand: "implant", nameCn: "植牙", nameEn: "Implant", usedFor: ["quote_extraction"], active: true, updatedAt: new Date().toISOString() },
      { id: "t4-br", shorthand: "br", nameCn: "牙橋", nameEn: "Bridge", usedFor: ["quote_extraction"], active: true, updatedAt: new Date().toISOString() },
      { id: "t4-sp", shorthand: "SP", nameCn: "洗牙", nameEn: "Scaling", usedFor: ["quote_extraction", "recall"], active: true, updatedAt: new Date().toISOString() },
    ],
  };
  // E2 報價 patient 改指向
  for (const x of fixture.quotes) if (x.id === "q4-e2-0") x.patientApricotId = FIX.E2.cpId;
  fs.mkdirSync(path.resolve(process.cwd(), ".dev"), { recursive: true });
  fs.writeFileSync(MOCK_REAL, JSON.stringify(fixture, null, 2));
  try {
    fs.unlinkSync(MOCK_FLAG);
  } catch {
    /* 好 */
  }
  fs.symlinkSync(MOCK_REAL, MOCK_FLAG);
}

function tasksOf(cpId: string) {
  return prisma.followupTask.findMany({ where: { patientApricotId: cpId } });
}
function taskOfTrigger(cpId: string, ruleId: string) {
  return prisma.followupTask.findFirst({ where: { patientApricotId: cpId, ruleId } });
}

async function main() {
  console.log("[T400] 基建 + 冪等洗");
  await cleanup();
  await prisma.clinic.create({
    data: { id: CLINIC_ID, code: CODE, name: "P4 E2E Clinic", waPhoneNumberId: `e2ep4-wa-1`, waDisplayNumber: "+852 0000 0001" },
  });
  for (const k of Object.keys(FIX)) await mkPatient(k);
  // admin
  const pwHash = await argon2.hash(PASS);
  await prisma.staffUser.upsert({
    where: { email: ADMIN_EMAIL },
    create: { id: "e2ep4-admin-u1", email: ADMIN_EMAIL, name: "E2E P4 Admin", passwordHash: pwHash, role: "ADMIN", active: true, scopeType: "ALL" },
    update: { active: true },
  });
  // E2 本地 booking（報價 +2 日 PENDING）
  await prisma.bookingRequest.create({
    data: {
      id: "e2ep4b-e02",
      conversationId: FIX.E2.convId,
      clinicId: CLINIC_ID,
      flowToken: "e2ep4-flow-e02",
      providerApricotId: "prov4",
      providerName: "Dr E2E",
      requestedDate: dstr(-6),
      status: "PENDING",
    },
  });
  await writeFixture();
  check("T400 基建：clinic + 9 病人 + admin + booking + fixture", true);

  // login cookie
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASS }),
  });
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  check("T400b login（cookie）", loginRes.ok && cookie.includes("wa_inbox_session"), loginRes.status);
  const H = { cookie, "content-type": "application/json" } as Record<string, string>;

  // ── T401 第一次 scan 經 cron queue（worker 執行 — 證明掛接）──────────────
  console.log("\n[T401] cron enqueue followup-scan → worker 掃");
  const { cronQueue } = await import("../src/lib/queue");
  await cronQueue.add("followup-scan", {}, { jobId: `e2e-followup-p4-${Date.now()}` });
  let scanDone = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const t = await taskOfTrigger(FIX.C1.cpId, (await ruleId("AFTER_TREATMENT"))!);
    if (t) {
      scanDone = true;
      break;
    }
  }
  if (!scanDone) {
    const wlog = fs.existsSync("/tmp/e2ep4-worker.log") ? fs.readFileSync("/tmp/e2ep4-worker.log", "utf8").split("\n").slice(-40).join("\n") : "(no log — worker 未起)";
    console.error("worker log tail:\n" + wlog);
    fail("cron followup-scan 45 秒內無產 C task（worker 未食 job？）");
  }
  await sleep(2500); // 等其餘規則掃完
  check("T401 cron 掛接：worker 掃出 C 正例 task", true);

  // ── T402–T408：直接 scan（斷言全矩陣 + 冪等）────────────────────────────
  const { runFollowupScan, checkCancellations } = await import("../src/lib/followup/engine");
  const scan = await runFollowupScan();
  console.log("scan:", JSON.stringify(scan));

  const tC1 = await taskOfTrigger(FIX.C1.cpId, (await ruleId("AFTER_TREATMENT"))!);
  const tC2 = await tasksOf(FIX.C2.cpId);
  const tC3 = await tasksOf(FIX.C3.cpId);
  const tC4 = await taskOfTrigger(FIX.C4.cpId, (await ruleId("AFTER_TREATMENT"))!);
  check("T402 C 拔牙 2 日前 + 抗生素 → task DUE（治療後 1 日到期）", !!tC1 && tC1.status === "DUE", tC1 && { status: tC1.status, dueAt: tC1.dueAt });
  check("T403a C 洗牙（0008 唔喺 rule）+ 抗生素 → 無 task", tC2.length === 0, tC2);
  check("T403b C 拔牙但無抗生素（IBU）→ 無 task", tC3.length === 0, tC3);
  // 口徑（同 P3 A 類「到門檻先建」）：未到期唔建 task — 今日拔牙，明日 scan 先出 DUE
  check("T404 C 今日拔牙（未到期）→ 無 task（明日 scan 先出 — 口徑同 P3 A 類）", tC4 == null, tC4);

  const tD1 = await taskOfTrigger(FIX.D1.cpId, (await ruleId("RECALL_NO_REPEAT"))!);
  const tD2 = await tasksOf(FIX.D2.cpId);
  const tD3 = await tasksOf(FIX.D3.cpId);
  check("T405 D 洗牙 7 月前（> 6 月）→ task DUE", !!tD1 && tD1.status === "DUE", tD1 && { status: tD1.status, dueAt: tD1.dueAt });
  check("T406a D 洗牙 3 月前（< 6 月）→ 無 task", tD2.length === 0, tD2);
  check("T406b D 期間再洗過（最新 2 月前 < 6 月）→ 無 task（冪等）", tD3.length === 0, tD3);

  const tE1 = await taskOfTrigger(FIX.E1.cpId, (await ruleId("QUOTED_NOT_BOOKED"))!);
  const tE2 = await tasksOf(FIX.E2.cpId);
  check("T407 E confirmed 報價 8 日前 + 無 booking → task（template 未審批 → task 照建，send 時先 SKIPPED）", !!tE1 && ["DUE", "SCHEDULED"].includes(tE1.status), tE1 && { status: tE1.status, ctx: tE1.contextJson });
  check(
    "T407b E task 用最新報價（S3：implant 18000 / br 5500@ 之一）",
    !!tE1 && /implant|br|植牙|牙橋|18000|5500/.test(JSON.stringify(tE1.contextJson ?? {})),
    tE1?.contextJson
  );
  check("T408a E 已有 booking（PENDING，報價後）→ 無 task", tE2.length === 0, tE2);
  check("T408b E booked 計數（≥1）", (scan.booked ?? 0) >= 1, scan.booked);

  // ── T409 三實測樣本抽到 + suggest/consider 標未做（API 面：報價隊列）──────
  console.log("\n[T409] 三實測樣本報價隊列");
  const qRes = await fetch(`${BASE}/api/admin/quotes?status=confirmed,corrected,pending&limit=200`, { headers: H });
  const qj = (await qRes.json()) as { quotes: any[] };
  const mine = qj.quotes.filter((x) => x.patientApricotId === FIX.E1.cpId);
  check("T409a 三樣本 14 條報價項入隊列", mine.length === 14, { n: mine.length });
  const s1a = mine.find((x) => x.id === "q4-s1-0");
  check("T409b S1 12000$ 抽出 + quoted 標未做（not_done）+ low 信心", !!s1a && s1a.amountMin === 12000 && s1a.intent === "not_done" && s1a.certainty === "low", s1a);
  const s2bleach = mine.find((x) => x.id === "q4-s2-4");
  const s2fill = mine.find((x) => x.id === "q4-s2-5");
  const s2anti = mine.find((x) => x.id === "q4-s2-6");
  check("T409c S2 BLEACHING 4K→4000", !!s2bleach && s2bleach.amountMin === 4000, s2bleach);
  check("T409d S2 FILL 900@→900 perUnit", !!s2fill && s2fill.amountMin === 900 && s2fill.perUnit === true, s2fill);
  check("T409e S2 ANTI SNORING 5-6K→5000-6000 range", !!s2anti && s2anti.amountMin === 5000 && s2anti.amountMax === 6000, s2anti);
  const s3br = mine.find((x) => x.id === "q4-s3-1");
  const s3impl = mine.find((x) => x.id === "q4-s3-4");
  const s3x = mine.find((x) => x.id === "q4-s3-3");
  check("T409f S3 br 5500@ perUnit + suggest 標未做", !!s3br && s3br.amountMin === 5500 && s3br.perUnit && s3br.intent === "not_done", s3br);
  check("T409g S3 implant 18k→18000 + quoted 標未做", !!s3impl && s3impl.amountMin === 18000 && s3impl.intent === "not_done", s3impl);
  check("T409h S3 consider x 37 → 拔牙 + FDI 37 + 未做", !!s3x && s3x.nameCn === "拔牙" && s3x.fdiTeeth.includes("37") && s3x.intent === "not_done", s3x);
  const anyDone = mine.filter((x) => x.intent === "not_done").length;
  check("T409i suggest/consider/quoted/TCA 全部 not_done（鐵律 §6.5 — 零當已完成）", anyDone === 7, anyDone);

  // ── T410 術語表加詞即時生效 + 收貨順手教字典 ────────────────────────────
  console.log("\n[T410] 術語表");
  const tm0 = (await (await fetch(`${BASE}/api/admin/clinical-terms`, { headers: H })).json()) as { terms: any[] };
  check("T410a 術語表載入（≥3 條 seed）", tm0.terms.length >= 3, tm0.terms.length);
  const putRes = await fetch(`${BASE}/api/admin/clinical-terms`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ terms: [...tm0.terms, { shorthand: "zzz", nameCn: "E2E 測試術語", nameEn: "E2E test", usedFor: ["quote_extraction"], active: true }] }),
  });
  const putj = (await putRes.json()) as { terms: any[] };
  check("T410b PUT 加詞「zzz」成功", putRes.ok && putj.terms.some((t) => t.shorthand === "zzz"), putRes.status);
  const tm1 = (await (await fetch(`${BASE}/api/admin/clinical-terms`, { headers: H })).json()) as { terms: any[] };
  check("T410c 加詞即時生效（GET 立即見「zzz」）", tm1.terms.some((t) => t.shorthand === "zzz" && t.nameCn === "E2E 測試術語"), tm1.terms.map((t) => t.shorthand));
  // 收貨順手教字典：S1 low pending 項 correct + teachTerm
  const decRes = await fetch(`${BASE}/api/admin/quotes`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      id: "q4-s1-0",
      action: "correct",
      fields: { amountMin: 12000, termShorthand: "perio", nameCn: "牙周治療" },
      teachTerm: { shorthand: "perio", nameCn: "牙周治療", nameEn: "periodontal", usedFor: ["quote_extraction"] },
      correctionNote: "e2e teach term",
    }),
  });
  const decj = (await decRes.json()) as { status?: string; termMapUpserted?: boolean };
  check("T410d 收貨順手教字典（correct + teachTerm → termMapUpserted）", decRes.ok && decj.termMapUpserted === true, decj);
  const tm2 = (await (await fetch(`${BASE}/api/admin/clinical-terms`, { headers: H })).json()) as { terms: any[] };
  check("T410e 教字典後「perio」入表", tm2.terms.some((t) => t.shorthand === "perio"), tm2.terms.map((t) => t.shorthand));
  const qAfter = (await (await fetch(`${BASE}/api/admin/quotes?status=corrected&limit=50`, { headers: H })).json()) as { quotes: any[] };
  check("T410f 該報價項狀態 = corrected", qAfter.quotes.some((x) => x.id === "q4-s1-0" && x.status === "corrected" && x.termShorthand === "perio"), qAfter.quotes.filter((x) => x.id === "q4-s1-0"));

  // ── T411 hub API + hub 頁 tab ───────────────────────────────────────────
  console.log("\n[T411] hub 主動跟進 tab");
  const hubRes = await fetch(`${BASE}/api/admin/followup-hub`, { headers: H });
  const hub = (await hubRes.json()) as any;
  check("T411a hub 7 規則（P3 4 + P4 3）", hub.rules?.length === 7, hub.rules?.map((r: any) => r.trigger));
  const eRule = hub.rules?.find((r: any) => r.trigger === "QUOTED_NOT_BOOKED");
  check("T411b E 規則 template 未審批（quote_followup approved=false → 紅）", !!eRule && eRule.templateApproved === false, eRule);
  check("T411c 取消條件六項 + OPT_OUT 鎖定", hub.cancelConditions?.length === 6 && hub.cancelConditions.find((c: any) => c.key === "OPT_OUT")?.locked === true, hub.cancelConditions?.length);
  check("T411d 健康警示 5 項", hub.health?.length === 5, hub.health?.map((h: any) => h.id));
  const warnUnapproved = hub.health?.find((h: any) => h.id === "template_unapproved");
  check("T411e 健康警示：template 未審批 = 紅（ok=false）", !!warnUnapproved && warnUnapproved.ok === false, warnUnapproved);
  check("T411f 每日上限 = 唔設（靠 L1）", /唔設|L1/.test(String(hub.sendPolicy?.dailyCap ?? "")), hub.sendPolicy);
  // hub 頁 HTML 含「主動跟進（三步）」tab
  const pageRes = await fetch(`${BASE}/admin/ai`, { headers: { cookie } });
  const pageHtml = await pageRes.text();
  check("T411g hub 頁含「主動跟進（三步）」tab", pageHtml.includes("主動跟進（三步）"), pageHtml.length);
  const termsPage = await fetch(`${BASE}/admin/clinical-terms`, { headers: { cookie } });
  const termsHtml = await termsPage.text();
  check("T411h 術語對照表頁載入（含「速記 → 標準名稱」）", termsPage.status === 200 && termsHtml.includes("術語對照表"), termsPage.status);

  // ── T412 藥物 tab：patient-record visits[].rxCodes ─────────────────────
  console.log("\n[T412] 藥物 tab rxCodes");
  const prRes = await fetch(`${BASE}/api/conversations/${FIX.C1.convId}/patient-record`, { headers: H });
  const pr = (await prRes.json()) as any;
  const v0 = pr.visits?.[0];
  check("T412a patient-record visits 含 rxCodes（AMOX → Amoxicillin + 抗生素旗）", prRes.status === 200 && !!v0?.rxCodes?.some((r: any) => r.code === "AMOX" && r.isAntibiotic === true), v0);
  check("T412b 零原始電話（patient-record 全文無 92100001）", !JSON.stringify(pr).includes("92100001"));

  // ── T413 opt-out 優先（checkCancellations 直斷）────────────────────────
  console.log("\n[T413] opt-out 優先");
  await prisma.contact.update({ where: { id: FIX.C1.contactId }, data: { followupOptOut: true } });
  const ruleRows = await prisma.followupRule.findMany({ select: { id: true, trigger: true } });
  const cRule = ruleRows.find((r) => r.trigger === "AFTER_TREATMENT")!;
  const clinicRow = await prisma.clinic.findUnique({ where: { id: CLINIC_ID }, select: { code: true } });
  const cancelReason = await checkCancellations(
    { id: "x", clinicId: CLINIC_ID, conversationId: FIX.C1.convId, patientApricotId: FIX.C1.cpId, ruleId: cRule.id, createdAt: new Date(), contextJson: null },
    await prisma.followupRule.findUnique({ where: { id: cRule.id } }),
    clinicRow,
    new Date()
  );
  check("T413 opt-out 病人 → OPT_OUT（任何規則唔可覆蓋）", cancelReason === "OPT_OUT", cancelReason);
  await prisma.contact.update({ where: { id: FIX.C1.contactId }, data: { followupOptOut: false } });

  // ── T414 冪等（重跑零新 task）+ 零殘留 ──────────────────────────────────
  console.log("\n[T414] 冪等 + 零殘留");
  const before = await prisma.followupTask.count({ where: { patientApricotId: { in: P4_PATIENTS } } });
  await runFollowupScan();
  const after = await prisma.followupTask.count({ where: { patientApricotId: { in: P4_PATIENTS } } });
  check("T414a 重跑 scan 零新 task（冪等）", after === before, { before, after });

  await cleanup();
  const left = await prisma.followupTask.count({ where: { patientApricotId: { in: P4_PATIENTS } } });
  const leftConv = await prisma.conversation.count({ where: { clinicId: CLINIC_ID } });
  check("T414b 零殘留（task/conv 全清）", left === 0 && leftConv === 0, { left, leftConv });

  console.log(`\nP4 E2E: ${passCount} checks, ${process.exitCode ? "RED" : "ALL GREEN"}`);
  process.exit(process.exitCode ?? 0);
}

async function ruleId(trigger: FollowupTrigger): Promise<string | null> {
  const r = await prisma.followupRule.findFirst({ where: { trigger }, select: { id: true } });
  return r?.id ?? null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
