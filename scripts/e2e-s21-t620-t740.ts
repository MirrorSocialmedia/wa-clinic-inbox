/**
 * e2e-s21-t620-t740.ts — cwi-final S2-1 驗收（T620 同一 appt 只出一次 / T740 並行 scan 每科目 1 行）
 *
 * 前置：Postgres 15432（已 apply cwi_final_s2_followup migration）；dev server 3100（API 斷言用唔到 — 純 in-process）。
 * 跑法：pnpm -s tsx scripts/e2e-s21-t620-t740.ts
 *
 * 決定性：
 *   - fixture 全部固定 id（s21 前綴）+ MF 店（seed 已有；mock P2 clinics 含 MF — MF 無內建 P2 預約，零干擾）。
 *   - 自建 2 條 MF-scoped 規則（B1 14d / IDLE 1d，dedupWindowDays=0）— 隔離 subject 級行為 vs 冷卻窗；
 *     global 規則零改動（seed 狀態零污染）。
 *   - runFollowupScan 直接 in-process 調（v3 慣例）；斷言全部跟 **DB 最終狀態**（subject 級 count）—
 *     dev worker 嘅每 10 分鐘 cron scan 就算段內觸發，都會被 unique partial index + 科目級終態收斂到同一狀態。
 *   - mock fixture：.dev/workforce-mock-followup.json（appointments：p1 0 / p102 改期舊單 102 / p2 / p3 / T740 p4）
 *     + .dev/workforce-mock-clinical.json（visits 空 + quotes：fresh -10d / old -25d — E 類上限）。
 *   - 段尾 hermetic 清理（tasks/conversations/contacts/rules/audit + mock 檔 unlink）。
 *
 * 斷言（marker 同 mock-e2e.sh 慣例）：
 *   T620a scan#1：p1 出 1（SUGGESTED）/ p102 改期舊單 0 / p2、p3 各 1 / convB idle 1 / quote fresh 1 / quote old（超 delay+14d 上限）0
 *   T620b scan×3（now/+1m/+2m）：0 新行（in-flight — 同 subject 唔再出）
 *   T620c 未釘 A 類：SKIPPED(MANUAL) → +10 分鐘 scan → 0 新行（subject 級終態，唔受窗影響）
 *   T620d 病人再講嘢（lastInboundAt 變）→ 再 idle scan → 出新建議（新 subject）
 *   T620e COMPLETED（病人覆）→ +8 日 scan → 0 新行（科目級終態永久 block — 7 日窗外都唔出）
 *   T740  兩個 runFollowupScan() 並行 → p4 + convE 每科目恰 1 行（P2002 防疊收斂）
 *   S21-SWEEP 零殘留
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.WORKFORCE_MOCK = "1"; // in-process engine 要食 mock（fetchAppointments/Visits/Quotes）
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { phoneHashes } from "../src/lib/phone-hash";

const prisma = new PrismaClient();
const RUN_START = new Date();

// ── 固定 id（cuid 形 — ≥20 lowercase alnum）─────────────────────────────────────────
const RULE_B1 = "s21ruleb1aaaaaaaaaaaaaaa1"; // BEFORE_APPOINTMENT 14d（MF scope，dedup 窗 0）
const RULE_A = "s21rulea000000000000000a1"; // CONVERSATION_IDLE 1d（MF scope，dedup 窗 0）

const WA = { p1: "94100001", p2: "94100002", p3: "94100003", b: "94100004", p4: "94100005", e1: "94100006", e0: "94100007", e: "94100008" };
const CP = { p1: "cps21-p1", p2: "cps21-p2", p3: "cps21-p3", p4: "cps21-p4", e1: "cps21-e1", e0: "cps21-e0" };
const CT: Record<string, string> = {
  p1: "s21ctp1aaaaaaaaaaaaaaa01", p2: "s21ctp2aaaaaaaaaaaaaaa02", p3: "s21ctp3aaaaaaaaaaaaaaa03",
  b: "s21ctbbaaaaaaaaaaaaaaa04", p4: "s21ctp4aaaaaaaaaaaaaaa05", e1: "s21cte1aaaaaaaaaaaaaaa06", e0: "s21cte0aaaaaaaaaaaaaaa07", e: "s21ctpeaaaaaaaaaaaaaaa08",
};
const CV: Record<string, string> = {
  p1: "s21convp1aaaaaaaaaaaaa01", p2: "s21convp2aaaaaaaaaaaaa02", p3: "s21convp3aaaaaaaaaaaaa03",
  b: "s21convbbaaaaaaaaaaaaa04", p4: "s21convp4aaaaaaaaaaaaa05", e1: "s21conve1aaaaaaaaaaaaa06", e0: "s21conve0aaaaaaaaaaaaa07", e: "s21convpeaaaaaaaaaaaaa08",
};
const ALL_CVS = Object.values(CV);
const ALL_CTS = Object.values(CT);
const ALL_CPS = Object.values(CP);

const MOCK_FOLLOWUP_LINK = path.resolve(process.cwd(), ".dev/workforce-mock-followup.json");
const MOCK_FOLLOWUP_REAL = "/tmp/s21-followup-mock.json";
const MOCK_CLINICAL_LINK = path.resolve(process.cwd(), ".dev/workforce-mock-clinical.json");
const MOCK_CLINICAL_REAL = "/tmp/s21-clinical-mock.json";

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passCount++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
  }
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

function dstr(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const hk = new Date(d.getTime() + 8 * 3_600_000);
  return hk.toISOString().slice(0, 10);
}

function mockLink(real: string, link: string, data: unknown): void {
  try {
    fs.unlinkSync(link);
  } catch {
    /* 冇 */
  }
  fs.writeFileSync(real, JSON.stringify(data, null, 2));
  fs.symlinkSync(real, link);
}

let t620Fails = 0;
let t740Fails = 0;
function check2(group: "t620" | "t740" | "sweep", name: string, ok: boolean, detail?: unknown): void {
  check(name, ok, detail);
  if (!ok) {
    if (group === "t620") t620Fails++;
    else if (group === "t740") t740Fails++;
  }
}

const subjCount = (subjectKey: string, status?: string) =>
  prisma.followupTask.count({ where: { subjectKey, ...(status ? { status: status as never } : {}) } });
const subjRows = (subjectKey: string) =>
  prisma.followupTask.findMany({ where: { subjectKey }, select: { id: true, status: true, conversationId: true, patientApricotId: true, cancelReason: true } });

async function main(): Promise<void> {
  const pg = (await import("node:child_process")).spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "15432", "-q"]);
  if (pg.status !== 0) fail("Postgres 15432 唔喺");

  const mf = await prisma.clinic.findFirst({ where: { code: "MF" } });
  if (!mf) fail("MF clinic 搵唔到（seed？）");

  // ── 冪等洗（固定 id）────────────────────────────────────────────────────
  await prisma.followupTask.deleteMany({ where: { OR: [{ conversationId: { in: ALL_CVS } }, { patientApricotId: { in: ALL_CPS } }, { ruleId: { in: [RULE_B1, RULE_A] } }] } });
  await prisma.conversation.deleteMany({ where: { id: { in: ALL_CVS } } });
  await prisma.contact.deleteMany({ where: { id: { in: ALL_CTS } } });
  await prisma.followupRule.deleteMany({ where: { id: { in: [RULE_B1, RULE_A] } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ALL_CVS, RULE_B1, RULE_A] } } });
  for (const real of [MOCK_FOLLOWUP_REAL, MOCK_CLINICAL_REAL]) {
    try {
      fs.unlinkSync(real);
    } catch {
      /* 冇 */
    }
  }

  // ── rules（MF scope；dedupWindowDays=0 隔離科目級行為 vs 冷卻窗）──────────────
  const now0 = new Date();
  for (const [id, trig, delay, tmpl] of [
    [RULE_B1, "BEFORE_APPOINTMENT", 14, "appt_reminder"],
    [RULE_A, "CONVERSATION_IDLE", 1, "conversation_followup"],
  ] as const) {
    await prisma.followupRule.upsert({
      where: { id },
      update: {
        clinicId: mf.id, name: `S21 E2E ${trig}`, enabled: true, trigger: trig as never, delayValue: delay,
        delayUnit: "DAY" as never, reasonCodes: [], templateName: tmpl, level: "L1" as never, maxSends: 1,
        dedupWindowDays: 0, firstUseConfirmedAt: now0,
      },
      create: {
        id, clinicId: mf.id, name: `S21 E2E ${trig}`, enabled: true, trigger: trig as never, delayValue: delay,
        delayUnit: "DAY" as never, reasonCodes: [], templateName: tmpl, level: "L1" as never, maxSends: 1,
        dedupWindowDays: 0, firstUseConfirmedAt: now0,
      },
    });
  }

  // ── contacts + conversations（固定 id）────────────────────────────────────
  const mk = async (k: "p1" | "p2" | "p3" | "b" | "p4" | "e1" | "e0", lastInbound: Date, pin: string | null) => {
    const ct = await prisma.contact.upsert({
      where: { id: CT[k] },
      update: { clinicId: mf.id, profileName: `S21 ${k}` },
      create: { id: CT[k], clinicId: mf.id, waId: WA[k], profileName: `S21 ${k}`, labels: [] },
    });
    await prisma.conversation.upsert({
      where: { id: CV[k] },
      update: { lastInboundAt: lastInbound, lastOutboundAt: lastInbound, lastMessageAt: lastInbound, pinnedPatientApricotId: pin, status: "OPEN" },
      create: { id: CV[k], clinicId: mf.id, contactId: ct.id, status: "OPEN", lastInboundAt: lastInbound, lastOutboundAt: lastInbound, lastMessageAt: lastInbound, pinnedPatientApricotId: pin },
    });
  };
  const H = 3_600_000, D = 86_400_000;
  // p1/p2/p3/e1/e0：B1/E 類 — 最近 inbound（A 類唔候選）；b：未釘 A 類 — 2 日 idle
  await mk("p1", new Date(Date.now() - 1 * H), CP.p1);
  await mk("p2", new Date(Date.now() - 1 * H), CP.p2);
  await mk("p3", new Date(Date.now() - 1 * H), CP.p3);
  await mk("e1", new Date(Date.now() - 1 * H), CP.e1);
  await mk("e0", new Date(Date.now() - 1 * H), CP.e0);
  const B_INBOUND1 = new Date(Date.now() - 2 * D);
  await mk("b", B_INBOUND1, null);

  // ── mock fixture（phase 1：p1 / p102 改期舊單 / p2 / p3 + quotes）──────────
  const apptsPhase1 = {
    appointments: [
      { apricotApptId: "s21apt-p1", clinicCode: "MF", date: dstr(12), start: "10:00", end: "10:30", providerApricotId: "S21-DR1", providerName: "S21 醫生", patientApricotId: CP.p1, bookingStatus: 0, phoneHashes: phoneHashes(WA.p1) },
      { apricotApptId: "s21apt-p102", clinicCode: "MF", date: dstr(12), start: "11:30", end: "12:00", providerApricotId: "S21-DR1", providerName: "S21 醫生", patientApricotId: CP.p1, bookingStatus: 102, phoneHashes: phoneHashes(WA.p1) }, // 被改期嘅舊單（W-8）— 唔提醒
      { apricotApptId: "s21apt-p2", clinicCode: "MF", date: dstr(12), start: "09:00", end: "09:30", providerApricotId: "S21-DR2", providerName: "S21 醫生2", patientApricotId: CP.p2, bookingStatus: 0, phoneHashes: phoneHashes(WA.p2) },
      { apricotApptId: "s21apt-p3", clinicCode: "MF", date: dstr(13), start: "15:00", end: "15:30", providerApricotId: "S21-DR2", providerName: "S21 醫生2", patientApricotId: CP.p3, bookingStatus: 0, phoneHashes: phoneHashes(WA.p3) },
    ],
    balances: {},
  };
  const clinicalPhase1 = {
    visits: [],
    quotes: [
      { id: "s21quote-fresh", patientApricotId: CP.e1, clinicCode: "MF", sourceVisitDate: dstr(-10), text: "e2e quote fresh（-10d，未到 delay+14d 上限）", termShorthand: null, nameCn: null, amountMin: 1000, amountMax: 2000, perUnit: false, fdiTeeth: [], intent: "unknown", certainty: "high", source: "parser", status: "confirmed" },
      { id: "s21quote-old", patientApricotId: CP.e0, clinicCode: "MF", sourceVisitDate: dstr(-25), text: "e2e quote old（-25d，超 delay 7d + 14d 上限）", termShorthand: null, nameCn: null, amountMin: 500, amountMax: 800, perUnit: false, fdiTeeth: [], intent: "unknown", certainty: "high", source: "parser", status: "confirmed" },
    ],
    terms: [],
    indexStatus: { lastNightly: null, phoneNormalize: { total: 0, withHash: 0, rate: null } },
  };
  mockLink(MOCK_FOLLOWUP_REAL, MOCK_FOLLOWUP_LINK, apptsPhase1);
  mockLink(MOCK_CLINICAL_LINK, MOCK_CLINICAL_REAL, clinicalPhase1);

  const { runFollowupScan } = await import("../src/lib/followup/engine");
  const eRule = await prisma.followupRule.findFirst({ where: { trigger: "QUOTED_NOT_BOOKED", enabled: true } });
  if (!eRule) fail("global E 規則（QUOTED_NOT_BOOKED）搵唔到（seed？）");

  // ── T620a：scan#1（now）— 建 ─────────────────────────────────────────────
  console.log("\n[T620a] scan#1（now）：同一 appt 出一次 + 102 舊單唔出 + E 類上限");
  const scan1 = await runFollowupScan();
  console.log(`  scan1: ${JSON.stringify({ rules: scan1.rules, created: scan1.created, inFlight: scan1.inFlight, subjectDone: scan1.subjectDone, dedupWindow: scan1.dedupWindow, expiredAtCreate: (scan1 as any).expiredAtCreate })}`);

  const SUBJ = {
    p1: "appt:s21apt-p1",
    p102: "appt:s21apt-p102",
    p2: "appt:s21apt-p2",
    p3: "appt:s21apt-p3",
    p4: "appt:s21apt-p4",
    qb: `idle:${CV.b}:${B_INBOUND1.toISOString()}`,
    qf: "quote:s21quote-fresh",
    qo: "quote:s21quote-old",
  };
  const b1rows = await subjRows(SUBJ.p1);
  check2("t620", "T620a1 p1 恰 1 條 SUGGESTED（建）", b1rows.length === 1 && b1rows[0].status === "SUGGESTED" && b1rows[0].conversationId === CV.p1 && b1rows[0].patientApricotId === CP.p1, b1rows);
  check2("t620", "T620a2 p102 改期舊單 0 條（B1 只取有效預約 status 0）", (await subjCount(SUBJ.p102)) === 0, await subjRows(SUBJ.p102));
  check2("t620", "T620a3 p2 恰 1 條 SUGGESTED", (await subjCount(SUBJ.p2, "SUGGESTED")) === 1, await subjRows(SUBJ.p2));
  check2("t620", "T620a4 p3 恰 1 條 SUGGESTED", (await subjCount(SUBJ.p3, "SUGGESTED")) === 1, await subjRows(SUBJ.p3));
  const bRows1 = await subjRows(SUBJ.qb);
  check2("t620", "T620a5 convB（未釘 A 類）恰 1 條 SUGGESTED（subject=idle:conv:lastInboundISO）", bRows1.length === 1 && bRows1[0].status === "SUGGESTED" && bRows1[0].patientApricotId === null, bRows1);
  check2("t620", "T620a6 quote fresh（-10d）恰 1 條 SUGGESTED（E 類正常出）", (await subjCount(SUBJ.qf, "SUGGESTED")) === 1, await subjRows(SUBJ.qf));
  check2("t620", "T620a7 quote old（-25d 超 delay+14d 上限）0 條", (await subjCount(SUBJ.qo)) === 0, await subjRows(SUBJ.qo));

  // ── T620b：scan×3（now/+1m/+2m）— 跳過（0 新行）────────────────────────────
  console.log("\n[T620b] scan×3（now/+1m/+2m）：同 subject 0 新行（in-flight）");
  for (const offMs of [0, 60_000, 120_000]) {
    await runFollowupScan(new Date(Date.now() + offMs));
  }
  const b1rows3 = await subjRows(SUBJ.p1);
  check2("t620", "T620b1 p1 總行數仍 = 1（scan×3 零新行）", b1rows3.length === 1 && b1rows3[0].status === "SUGGESTED", b1rows3);
  check2("t620", "T620b2 p2/p3 仍各 1 條 SUGGESTED", (await subjCount(SUBJ.p2, "SUGGESTED")) === 1 && (await subjCount(SUBJ.p3, "SUGGESTED")) === 1);
  check2("t620", "T620b3 convB 仍 1 條 SUGGESTED（0 新行）", (await subjCount(SUBJ.qb, "SUGGESTED")) === 1 && (await subjCount(SUBJ.qb)) === 1, await subjRows(SUBJ.qb));
  console.log(t620Fails === 0 ? "T620-OK-PARTIAL" : "T620-PARTIAL-FAIL");

  // ── T620c：未釘 A 類 SKIPPED(MANUAL) → +10 分鐘 scan → 0 新行 ──────────────
  console.log("\n[T620c] 未釘 A 類：SKIPPED(MANUAL) → +10 分鐘 scan → 0 新行（subject 級終態）");
  const nowC = new Date();
  const skipped = await prisma.followupTask.updateMany({ where: { subjectKey: SUBJ.qb, status: "SUGGESTED" }, data: { status: "SKIPPED", cancelReason: "MANUAL", handledAt: nowC } });
  check2("t620", "T620c0 convB task → SKIPPED(MANUAL)", skipped.count === 1, skipped.count);
  await runFollowupScan(new Date(Date.now() + 10 * 60_000));
  const bRows2 = await subjRows(SUBJ.qb);
  check2("t620", "T620c1 +10 分鐘 scan：convB 舊 subject 零新行（SKIPPED = 科目終態）", bRows2.length === 1 && bRows2[0].status === "SKIPPED", bRows2);

  // ── T620d：病人再講嘢 → 再 idle → 新 subject 出新建議 ──────────────────────
  console.log("\n[T620d] 病人再講嘢（lastInboundAt 變）→ 新 subject → 出新建議");
  const B_INBOUND2 = new Date(Date.now() - 2 * D + 10 * 60_000); // 仲係 >1 日 idle（對 +11 分鐘 scan 而言）
  await prisma.conversation.update({ where: { id: CV.b }, data: { lastInboundAt: B_INBOUND2, lastMessageAt: B_INBOUND2 } });
  const SUBJ_B2 = `idle:${CV.b}:${B_INBOUND2.toISOString()}`;
  await runFollowupScan(new Date(Date.now() + 11 * 60_000));
  const bRows3 = await subjRows(SUBJ_B2);
  check2("t620", "T620d1 新 subject 恰 1 條 SUGGESTED（病人再講嘢 = 新科目）", bRows3.length === 1 && bRows3[0].status === "SUGGESTED" && bRows3[0].conversationId === CV.b, bRows3);
  check2("t620", "T620d2 舊 subject 行不變（SKIPPED、未被重複）", (await subjRows(SUBJ.qb)).length === 1, await subjRows(SUBJ.qb));

  // ── T620e：COMPLETED（病人覆）→ +8 日 scan → 0 新行 ───────────────────────
  console.log("\n[T620e] p1 COMPLETED（病人覆）→ +8 日 scan → 0 新行（科目級終態 — 7 日窗外都唔出）");
  const nowE = new Date();
  const completed = await prisma.followupTask.updateMany({ where: { subjectKey: SUBJ.p1, status: "SUGGESTED" }, data: { status: "COMPLETED", handledAt: nowE, note: "T620e 病人覆" } });
  check2("t620", "T620e0 p1 task → COMPLETED", completed.count === 1, completed.count);
  const scan8 = await runFollowupScan(new Date(Date.now() + 8 * D));
  console.log(`  scan@+8d: ${JSON.stringify({ expired: scan8.expired, created: scan8.created, inFlight: scan8.inFlight, subjectDone: scan8.subjectDone })}`);
  const b1rows8 = await subjRows(SUBJ.p1);
  check2("t620", "T620e1 +8 日 scan：p1 零新行（COMPLETED = 科目終態，永久 block）", b1rows8.length === 1 && b1rows8[0].status === "COMPLETED", b1rows8);
  check2("t620", "T620e2 p2/p3 仲係 SUGGESTED（未到期、in-flight 唔重複）", (await subjCount(SUBJ.p2, "SUGGESTED")) === 1 && (await subjCount(SUBJ.p3, "SUGGESTED")) === 1);
  check2("t620", "T620e3 quote fresh 仲係 1 條 SUGGESTED（未過期）", (await subjCount(SUBJ.qf, "SUGGESTED")) === 1, await subjRows(SUBJ.qf));
  console.log(t620Fails === 0 ? "T620-OK" : `T620-FAIL（${t620Fails} 項）`);

  // ── T740：兩個 runFollowupScan() 並行 → 每科目恰 1 行 ──────────────────────
  console.log("\n[T740] 並行雙 scan：新科目（p4 預約 + convE idle）每科目恰 1 行（P2002 防疊）");
  await mk("p4", new Date(Date.now() - 1 * H), CP.p4);
  // convE：專屬 contact（Conversation 有 (clinicId, contactId) unique — 一 contact 一 conv）
  const ctE = await prisma.contact.upsert({
    where: { id: CT.e },
    update: { clinicId: mf.id, profileName: "S21 e" },
    create: { id: CT.e, clinicId: mf.id, waId: WA.e, profileName: "S21 e", labels: [] },
  });
  await prisma.conversation.upsert({
    where: { id: CV.e },
    update: { lastInboundAt: B_INBOUND2, lastOutboundAt: B_INBOUND2, lastMessageAt: B_INBOUND2, pinnedPatientApricotId: null, status: "OPEN" },
    create: { id: CV.e, clinicId: mf.id, contactId: ctE.id, status: "OPEN", lastInboundAt: B_INBOUND2, lastOutboundAt: B_INBOUND2, lastMessageAt: B_INBOUND2, pinnedPatientApricotId: null },
  });
  const apptsPhase2 = {
    appointments: [
      ...apptsPhase1.appointments,
      { apricotApptId: "s21apt-p4", clinicCode: "MF", date: dstr(12), start: "12:00", end: "12:30", providerApricotId: "S21-DR1", providerName: "S21 醫生", patientApricotId: CP.p4, bookingStatus: 0, phoneHashes: phoneHashes(WA.p4) },
    ],
    balances: {},
  };
  mockLink(MOCK_FOLLOWUP_REAL, MOCK_FOLLOWUP_LINK, apptsPhase2);
  const SUBJ_BE = `idle:${CV.e}:${B_INBOUND2.toISOString()}`;
  const nowT = new Date();
  await Promise.all([runFollowupScan(nowT), runFollowupScan(nowT)]);
  const p4rows = await subjRows(SUBJ.p4);
  check2("t740", "T740a p4（並行雙 scan）恰 1 條 SUGGESTED", p4rows.length === 1 && p4rows[0].status === "SUGGESTED" && p4rows[0].conversationId === CV.p4, p4rows);
  const berows = await subjRows(SUBJ_BE);
  check2("t740", "T740b convE idle（並行雙 scan）恰 1 條 SUGGESTED", berows.length === 1 && berows[0].status === "SUGGESTED", berows);
  check2("t740", "T740c p1/p2/p3 無疊（各恰 1 行）", (await subjRows(SUBJ.p1)).length === 1 && (await subjCount(SUBJ.p2, "SUGGESTED")) === 1 && (await subjCount(SUBJ.p3, "SUGGESTED")) === 1);
  check2("t740", "T740d quote fresh 無疊（恰 1 行）", (await subjRows(SUBJ.qf)).length === 1, await subjRows(SUBJ.qf));
  console.log(t740Fails === 0 ? "T740-OK" : `T740-FAIL（${t740Fails} 項）`);

  // ── sweep：hermetic 清理 + 零殘留 ─────────────────────────────────────────
  console.log("\n[S21-SWEEP] hermetic 清理");
  await prisma.followupTask.deleteMany({ where: { OR: [{ conversationId: { in: ALL_CVS } }, { patientApricotId: { in: ALL_CPS } }, { ruleId: { in: [RULE_B1, RULE_A] } }, { createdAt: { gte: RUN_START } }] } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...ALL_CVS, RULE_B1, RULE_A] } }, { action: { startsWith: "FOLLOWUP_" }, createdAt: { gte: RUN_START } }] } });
  await prisma.conversation.deleteMany({ where: { id: { in: ALL_CVS } } });
  await prisma.contact.deleteMany({ where: { id: { in: ALL_CTS } } });
  await prisma.followupRule.deleteMany({ where: { id: { in: [RULE_B1, RULE_A] } } });
  for (const [real, link] of [
    [MOCK_CLINICAL_REAL, MOCK_CLINICAL_LINK],
    [MOCK_FOLLOWUP_REAL, MOCK_FOLLOWUP_LINK],
  ] as [string, string][]) {
    try {
      fs.unlinkSync(link);
    } catch {
      /* 冇 */
    }
    try {
      fs.unlinkSync(real);
    } catch {
      /* 冇 */
    }
  }
  const residual =
    (await prisma.followupTask.count({ where: { OR: [{ conversationId: { in: ALL_CVS } }, { patientApricotId: { in: ALL_CPS } }, { ruleId: { in: [RULE_B1, RULE_A] } }] } })) +
    (await prisma.conversation.count({ where: { id: { in: ALL_CVS } } })) +
    (await prisma.contact.count({ where: { id: { in: ALL_CTS } } })) +
    (await prisma.followupRule.count({ where: { id: { in: [RULE_B1, RULE_A] } } }));
  check2("sweep", "S21-SWEEP 零殘留（tasks/convs/contacts/rules）", residual === 0, { residual });
  const sweepOk = residual === 0;

  // ── markers（mock-e2e.sh grep 用）────────────────────────────────────────
  console.log(sweepOk ? "S21-SWEEP-OK" : "S21-SWEEP-FAIL");
  console.log(`\n=== e2e-s21 T620/T740 完成：${passCount} 項通過 / ${failCount} 項失敗${failCount ? "（有失敗！）" : "（全綠）"} ===`);
}

main()
  .catch((err) => {
    console.error("\n[unhandled]", err);
    console.log("T620-FAIL");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect().catch(() => undefined).finally(() => process.exit(process.exitCode ?? 0));
  });
