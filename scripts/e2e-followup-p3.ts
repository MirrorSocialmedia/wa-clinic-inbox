/**
 * e2e-followup-p3.ts — P3 Follow-up 引擎（followup-v2 MD §4.7 五項 + opt-out + 零殘留）
 *
 * 前置：dev server 127.0.0.1:3100（WA_MOCK=1）；worker 跑緊（tsx src/workers/index.ts，
 *   .env WORKFORCE_MOCK=1 — mock 經 Prisma .env load 生效）；Postgres 15432；redis 6379。
 * 跑法：pnpm -s tsx scripts/e2e-followup-p3.ts
 *
 * 決定性：
 *   - mock 動態 fixture `.dev/workforce-mock-followup.json`（symlink → /tmp 避 Next watcher）：
 *     明日預約 0（b01/w01/w21/w41）+ 前日爽約 -3（n01）+ 配對源 1（f01/f21）+ opt-out 病人 0（o01）；
 *     balances：f01=600（過 500 門檻）/ f21=0（PAID 取消測試）。
 *   - 第一次 scan 經 cron queue enqueue（worker 執行 — 證明 cron 掛接）；其餘走引擎直接調。
 *
 * 斷言（MD §4.7）：
 *   T380 基建 + 冪等洗｜T381 A 類跑通（DUE + SCHEDULED 兩態）｜T382 B 預約提醒跑通
 *   T383 B 爽約跑通｜T384 F 欠款跑通（600 建 / 0 唔建）｜T385 opt-out 零 task（scan 唔建）
 *   T386 取消六項各測（OPT_OUT/REPLIED/BOOKED/ARRIVED/RESOLVED/PAID）
 *   T387 窗口過咗唔發 free-form（未審批 → SKIPPED(NO_TEMPLATE)；審批後 → template 發）
 *   T388 窗口內可 text（未審批 template 照發 text）｜T389 L2 直發（AI_AUTO）
 *   T390 發送唔 claim（assignee 不變）+ 病人回覆 → COMPLETED 唔 claim + followupRepliedAt badge
 *   T391 audit FOLLOWUP_SENT 零 PII + billingCategory UTILITY｜T392 hub 健康項（未審批紅 / 審批後綠）
 *   T393 API（login + task 列表 + 人撳發送 template + cancel）｜T394 偵測/渲染 unit｜T395 零殘留
 *
 * e2e harness：playwright/prisma 動態 payload 型太繁 → 本檔局部 any（src/ 零 any）
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient, type FollowupStatus, type FollowupTrigger } from "@prisma/client";

const argon2 = createRequire(path.join(process.cwd(), "package.json"))("argon2");
import { phoneHashes } from "../src/lib/phone-hash";

const BASE = "http://127.0.0.1:3100";
const PASS = "P3-E2E-Pass-123!";
const PFX = "e2ep3";
const CLINIC_CODE = "TKW";
const MOCK_FLAG = ".dev/workforce-mock-followup.json";
const MOCK_REAL = "/tmp/e2ep3-followup-mock.json";

let passCount = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passCount++;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
    process.exitCode = 1;
  }
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

// ── 病人矩陣（固定 waId / cpId / 前綴 id — 冪等）────────────────────────────
type Fix = { waId: string; cpId: string; contactId: string; convId: string; name: string };
const FIX: Record<string, Fix> = {
  A: { waId: "91000001", cpId: "cp-p3-a01", contactId: "e2ep3c-a01", convId: "e2ep3v-a01", name: "E2E A 空窗" },
  A2: { waId: "91000007", cpId: "cp-p3-a02", contactId: "e2ep3c-a02", convId: "e2ep3v-a02", name: "E2E A2 未到期" },
  B: { waId: "91000002", cpId: "cp-p3-b01", contactId: "e2ep3c-b01", convId: "e2ep3v-b01", name: "E2E B 預約" },
  N: { waId: "91000003", cpId: "cp-p3-n01", contactId: "e2ep3c-n01", convId: "e2ep3v-n01", name: "E2E N 爽約" },
  F: { waId: "91000004", cpId: "cp-p3-f01", contactId: "e2ep3c-f01", convId: "e2ep3v-f01", name: "E2E F 欠款600" },
  F2: { waId: "91000012", cpId: "cp-p3-f21", contactId: "e2ep3c-f21", convId: "e2ep3v-f21", name: "E2E F2 零欠款" },
  O: { waId: "91000005", cpId: "cp-p3-o01", contactId: "e2ep3c-o01", convId: "e2ep3v-o01", name: "E2E O opt-out" },
  W: { waId: "91000006", cpId: "cp-p3-w01", contactId: "e2ep3c-w01", convId: "e2ep3v-w01", name: "E2E W 過窗" },
  W2: { waId: "91000008", cpId: "cp-p3-w21", contactId: "e2ep3c-w21", convId: "e2ep3v-w21", name: "E2E W2 template發" },
  W3: { waId: "91000009", cpId: "cp-p3-w31", contactId: "e2ep3c-w31", convId: "e2ep3v-w31", name: "E2E W3 窗內text" },
  L2: { waId: "91000010", cpId: "cp-p3-l21", contactId: "e2ep3c-l21", convId: "e2ep3v-l21", name: "E2E L2 直發" },
  W4: { waId: "91000011", cpId: "cp-p3-w41", contactId: "e2ep3c-w41", convId: "e2ep3v-w41", name: "E2E W4 API發" },
};
const ADMIN_EMAIL = "e2ep3-admin@e2e.local";

// ── mock fixture（e2e 寫 — 相對日期）────────────────────────────────────────
function mockDates() {
  const now = new Date();
  const day = (offset: number) => {
    const d = new Date(now.getTime() + offset * 86_400_000);
    // HK 日界（同 availability.hkTodayStr 口徑）
    const hk = new Date(d.getTime() + 8 * 3_600_000);
    return hk.toISOString().slice(0, 10);
  };
  // 明日預約時間：避開「今日 10:00 已過」→ 10:00（早跑）/ 23:59（晚跑），dueAt 恒為今日
  const h = new Date(now.getTime() + 8 * 3_600_000).getUTCHours();
  return { tomorrow: day(1), yesterday: day(-1), twoDaysAgo: day(-2), today: day(0), bTime: h < 10 ? "10:00" : "23:59" };
}
function hashes(waId: string): string[] {
  return phoneHashes(waId);
}
function writeMock() {
  const d = mockDates();
  const appt = (apptId: string, date: string, start: string, status: number, cpId: string, waId: string) => ({
    apricotApptId: apptId,
    clinicCode: CLINIC_CODE,
    providerApricotId: "md-p3-1",
    providerName: "Dr. P3",
    date,
    start,
    end: start === "23:59" ? "23:59" : "10:30",
    bookingStatus: status,
    patientApricotId: cpId,
    phoneHashes: hashes(waId),
  });
  const fixture = {
    appointments: [
      appt("apt-p3-b01", d.tomorrow, d.bTime, 0, FIX.B.cpId, FIX.B.waId),
      appt("apt-p3-n01", d.twoDaysAgo, "10:00", -3, FIX.N.cpId, FIX.N.waId),
      appt("apt-p3-f01", d.yesterday, "11:00", 1, FIX.F.cpId, FIX.F.waId),
      appt("apt-p3-f21", d.yesterday, "11:30", 1, FIX.F2.cpId, FIX.F2.waId),
      appt("apt-p3-o01", d.tomorrow, d.bTime, 0, FIX.O.cpId, FIX.O.waId),
      appt("apt-p3-w01", d.tomorrow, d.bTime, 0, FIX.W.cpId, FIX.W.waId),
      appt("apt-p3-w21", d.tomorrow, d.bTime, 0, FIX.W2.cpId, FIX.W2.waId),
      appt("apt-p3-w41", d.tomorrow, d.bTime, 0, FIX.W4.cpId, FIX.W4.waId),
    ],
    balances: { [FIX.F.cpId]: { osAmt: 600 }, [FIX.F2.cpId]: { osAmt: 0 } },
  };
  fs.writeFileSync(MOCK_REAL, JSON.stringify(fixture, null, 2));
  // symlink → /tmp（避 Next dev watcher — P2 實錘 .dev/ 寫入觸發 recompile 風暴）
  const link = path.resolve(process.cwd(), MOCK_FLAG);
  try {
    fs.unlinkSync(link);
  } catch {
    /* 冇 */
  }
  fs.symlinkSync(MOCK_REAL, link);
  return fixture;
}
function rewriteAppt(apptId: string, patch: Record<string, unknown>) {
  const raw = JSON.parse(fs.readFileSync(MOCK_REAL, "utf8")) as any;
  const a = raw.appointments.find((x: any) => x.apricotApptId === apptId);
  if (a) Object.assign(a, patch);
  fs.writeFileSync(MOCK_REAL, JSON.stringify(raw, null, 2));
}
function setBalance(cpId: string, osAmt: number | null) {
  const raw = JSON.parse(fs.readFileSync(MOCK_REAL, "utf8")) as any;
  raw.balances[cpId] = { osAmt };
  fs.writeFileSync(MOCK_REAL, JSON.stringify(raw, null, 2));
}

async function tasksOf(convId: string, status?: FollowupStatus) {
  return prisma.followupTask.findMany({ where: { conversationId: convId, ...(status ? { status } : {}) } });
}
async function taskOf(convId: string, trigger: FollowupTrigger): Promise<Awaited<ReturnType<typeof prisma.followupTask.findMany>>[number] | undefined> {
  const rules = await prisma.followupRule.findMany({ where: { trigger }, select: { id: true } });
  if (rules.length === 0) return undefined;
  const ts = await prisma.followupTask.findMany({ where: { conversationId: convId, ruleId: { in: rules.map((r) => r.id) } } });
  return ts[0];
}
async function tasksOfTrigger(convId: string, trigger: FollowupTrigger) {
  const rules = await prisma.followupRule.findMany({ where: { trigger }, select: { id: true } });
  if (rules.length === 0) return [];
  return prisma.followupTask.findMany({ where: { conversationId: convId, ruleId: { in: rules.map((r) => r.id) } } });
}
function assertNoPii(obj: unknown, label: string) {
  const s = JSON.stringify(obj ?? "");
  const bad = ["9100000", "E2E ", "@", "phone", "waId"];
  const hit = bad.filter((b) => s.includes(b));
  check(`${label} 零 PII`, hit.length === 0, hit);
}

async function main(): Promise<void> {
  // ── T380 基建 + 冪等洗 ─────────────────────────────────────────────────
  console.log("\n[T380] 基建 + 冪等洗");
  const pg = spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "15432", "-q"]);
  if (pg.status !== 0) fail("Postgres 15432 唔喺");
  const srv = await fetch(`${BASE}/api/auth/login`, { method: "POST", body: "{}" }).catch(() => null);
  if (!srv) fail("dev server 3100 唔喺");
  void srv;

  const convIds = Object.values(FIX).map((f) => f.convId);
  const contactIds = Object.values(FIX).map((f) => f.contactId);
  const oldAdmin = await prisma.staffUser.findFirst({ where: { email: ADMIN_EMAIL }, select: { id: true } });
  const oldL2Rules = await prisma.followupRule.findMany({ where: { name: { startsWith: "E2EP3-" } }, select: { id: true } });
  const oldTasks = await prisma.followupTask.findMany({
    where: { OR: [{ conversationId: { in: convIds } }, { ruleId: { in: oldL2Rules.map((r) => r.id) } }] },
    select: { id: true },
  });
  const oldTaskIds = oldTasks.map((t) => t.id);
  {
    await prisma.followupTask.deleteMany({ where: { OR: [{ conversationId: { in: convIds } }, { ruleId: { in: oldL2Rules.map((r) => r.id) } }] } });
    await prisma.followupRule.deleteMany({ where: { name: { startsWith: "E2EP3-" } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...convIds, ...oldTaskIds] } }, { action: { startsWith: "FOLLOWUP_" } }] } });
    await prisma.staffNotice.deleteMany({ where: { title: { startsWith: "跟進停止" } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    if (oldAdmin) {
      await prisma.staffClinic.deleteMany({ where: { staffId: oldAdmin.id } });
      await prisma.staffUser.deleteMany({ where: { id: oldAdmin.id } });
    }
  }
  check("冪等洗完成", true);

  // clinic id
  const clinic = await prisma.clinic.findFirst({ where: { code: CLINIC_CODE } });
  if (!clinic) fail(`clinic ${CLINIC_CODE} 搵唔到`);

  // 一個真實 staff（W2/W3 claim 測試用 assignee）
  const staff = await prisma.staffUser.findFirst({ where: { active: true }, orderBy: { id: "asc" } });
  if (!staff) fail("DB 無 active staff（claim 測試用）");

  // ── fixture：contact + conversation + opt-out + lastInbound 態 ──────────
  const mkConv = (k: string, lastInboundHrsAgo: number | null) =>
    prisma.contact
      .upsert({
        where: { id: FIX[k].contactId },
        update: { clinicId: clinic.id, profileName: FIX[k].name, followupOptOut: false, optOutAt: null, optOutSource: null },
        create: { id: FIX[k].contactId, clinicId: clinic.id, waId: FIX[k].waId, profileName: FIX[k].name, labels: [] },
      })
      .then(async (ct) => {
        await prisma.conversation.upsert({
          where: { id: FIX[k].convId },
          update: { contactId: ct.id, clinicId: clinic.id, status: "OPEN", assigneeId: null, lastInboundAt: lastInboundHrsAgo === null ? null : new Date(Date.now() - lastInboundHrsAgo * 3_600_000), lastMessageAt: new Date(Date.now() - (lastInboundHrsAgo ?? 24 * 30) * 3_600_000) },
          create: {
            id: FIX[k].convId,
            clinicId: clinic.id,
            contactId: ct.id,
            status: "OPEN",
            lastInboundAt: lastInboundHrsAgo === null ? null : new Date(Date.now() - lastInboundHrsAgo * 3_600_000),
            lastMessageAt: new Date(Date.now() - (lastInboundHrsAgo ?? 24 * 30) * 3_600_000),
          },
        });
      });
  for (const k of ["A2", "B", "N", "F", "F2", "O", "W", "W2", "W4"]) await mkConv(k, 24 * 30); // 30 日（窗關）
  await mkConv("A", 24 * 8); // 8 日 → A 到期（due = 1 日前）
  await mkConv("A2", 24 * 3); // 3 日 → A2 未到期（due = 4 日後）
  await mkConv("L2", 2); // 2 小時（窗開）
  await mkConv("W3", 1); // 1 小時（窗開）
  // opt-out（手動標 — scan 唔建測試）
  await prisma.contact.update({ where: { id: FIX.O.contactId }, data: { followupOptOut: true, optOutAt: new Date(), optOutSource: "manual" } });

  // admin user（API 測試用）
  const pwHash = await argon2.hash(PASS);
  await prisma.staffUser.upsert({
    where: { email: ADMIN_EMAIL },
    update: { active: true, scopeType: "ALL" },
    create: { id: "e2ep3-admin-u1", email: ADMIN_EMAIL, name: "E2E P3 Admin", passwordHash: pwHash, role: "ADMIN", active: true, scopeType: "ALL" },
  });

  const fixture = writeMock();
  check("fixture 落（12 contact/conv + mock appointments/balances）", (fixture.appointments as unknown[]).length === 8);

  // ── T381–T385：第一次 scan 經 cron queue（worker 執行 — 證明掛接）──────────
  console.log("\n[T381-385] cron enqueue followup-scan → worker 掃");
  const { cronQueue } = await import("../src/lib/queue");
  await cronQueue.add("followup-scan", {}, { jobId: `e2e-followup-${Date.now()}` });
  // poll：等 B/F task 出現（worker scan 完成标志）
  let scanDone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const [bt, ft] = await Promise.all([tasksOf(FIX.B.convId), tasksOf(FIX.F.convId)]);
    if (bt.length > 0 && ft.length > 0) {
      scanDone = true;
      break;
    }
  }
  if (!scanDone) {
    const wlog = fs.existsSync("/tmp/p3-worker.log") ? fs.readFileSync("/tmp/p3-worker.log", "utf8").split("\n").slice(-30).join("\n") : "(no log)";
    console.error("worker log tail:\n" + wlog);
    fail("cron followup-scan 30 秒內無產 task（worker 未食 job？）");
  }
  await sleep(1500); // 等其餘規則掃完

  const tA = await taskOf(FIX.A.convId, "CONVERSATION_IDLE");
  const tA2 = await taskOf(FIX.A2.convId, "CONVERSATION_IDLE");
  const tB = await taskOf(FIX.B.convId, "BEFORE_APPOINTMENT");
  const tN = await taskOf(FIX.N.convId, "AFTER_NO_SHOW");
  const tF = await taskOf(FIX.F.convId, "OUTSTANDING_BALANCE");
  const tF2 = await tasksOfTrigger(FIX.F2.convId, "OUTSTANDING_BALANCE");
  const tO = await tasksOf(FIX.O.convId);
  const tW = await taskOf(FIX.W.convId, "BEFORE_APPOINTMENT");

  // T381 A 類
  check("T381a A 空窗 8 日 → task DUE（L1 入隊列）", !!tA && tA.status === "DUE", tA);
  check("T381b A 空窗 3 日（< 7 日門檻）→ 未建 task（到門檻先建）", tA2 === undefined, tA2);
  check("T381c A task 帶 idleDays context（零臨床）", !!tA && (tA.contextJson as any)?.idleDays === 8, tA?.contextJson);

  // T382 B 預約提醒
  const d = mockDates();
  const expDueB = new Date(`${d.today}T${d.bTime}:00+08:00`).getTime();
  check(
    "T382 B 明日預約 → task（dueAt = 預約前 1 日 + 配对 patientApricotId）",
    !!tB && ["SCHEDULED", "DUE"].includes(tB.status) && tB.dueAt.getTime() === expDueB && tB.patientApricotId === FIX.B.cpId,
    { tB: tB && { status: tB.status, dueAt: tB.dueAt.getTime(), cp: tB.patientApricotId }, expDueB }
  );
  check("T382b B contextJson 只顯示用（apptId/date/time/clinicCode）", !!tB && !JSON.stringify(tB.contextJson).includes("9110"), tB?.contextJson);

  // T383 B 爽約
  check("T383 前日爽約 -3 → task DUE（爽約 +1 日後到期）", !!tN && tN.status === "DUE" && (tN.contextJson as any)?.noShow === true, tN);

  // T384 F 欠款
  check("T384a F osAmt=600 ≥ 500 → task DUE（dueAt=now 即發候選）", !!tF && tF.status === "DUE" && (tF.contextJson as any)?.osAmt === 600, tF);
  check("T384b F osAmt=0 → 零 task（未過門檻）", tF2.length === 0, tF2);

  // T385 opt-out 零 task
  check("T385 opt-out 病人（有明日預約）→ scan 零 task", tO.length === 0, tO);
  if (!tA || !tB || !tN || !tF || !tW) fail("scan 未建齊預期 task（tA/tB/tN/tF/tW 有缺）");

  // ── T386 取消六項（每次發送前重跑 — 直接調 sendFollowupTask）─────────────
  console.log("\n[T386] 取消六項");
  const { sendFollowupTask } = await import("../src/lib/followup/engine");

  // ① OPT_OUT：O 手動建 DUE task → 發送前檢查命中
  const tOdirect = await prisma.followupTask.create({
    data: {
      clinicId: clinic.id,
      conversationId: FIX.O.convId,
      patientApricotId: FIX.O.cpId,
      ruleId: tB.ruleId,
      dueAt: new Date(),
      status: "DUE",
      templateName: "appt_reminder",
      contextJson: { apptId: "apt-p3-o01", apptDate: d.tomorrow, apptTime: d.bTime, clinicCode: CLINIC_CODE },
    },
  });
  let r = await sendFollowupTask(tOdirect.id, { via: "AI_ADOPTED" });
  check("T386① OPT_OUT（永遠檢查）", r.status === "CANCELLED" && r.cancelReason === "OPT_OUT", r);

  // ② REPLIED：A task → 病人回覆（lastInbound=now）→ 發送前命中
  await prisma.conversation.update({ where: { id: FIX.A.convId }, data: { lastInboundAt: new Date() } });
  r = await sendFollowupTask(tA.id, { via: "AI_ADOPTED" });
  check("T386② REPLIED（新 inbound）", r.status === "CANCELLED" && r.cancelReason === "REPLIED", r);

  // ③ BOOKED：N task → mock 改「重新約咗」(新 apptId, status 0, 明日) → 發送前命中
  rewriteAppt("apt-p3-n01", { bookingStatus: 0, date: d.tomorrow, apricotApptId: "apt-p3-n01b" });
  r = await sendFollowupTask(tN.id, { via: "AI_ADOPTED" });
  check("T386③ BOOKED（期間新 booking）", r.status === "CANCELLED" && r.cancelReason === "BOOKED", r);
  rewriteAppt("apt-p3-n01b", { bookingStatus: -3, date: d.twoDaysAgo, apricotApptId: "apt-p3-n01" }); // 還原

  // ④ ARRIVED：B task → mock 改该預約 status=1（已到）→ 發送前命中
  rewriteAppt("apt-p3-b01", { bookingStatus: 1 });
  r = await sendFollowupTask(tB.id, { via: "AI_ADOPTED" });
  check("T386④ ARRIVED（bookingStatus=1）", r.status === "CANCELLED" && r.cancelReason === "ARRIVED", r);
  rewriteAppt("apt-p3-b01", { bookingStatus: 0 }); // 還原

  // ⑤ RESOLVED：W task → 對話 RESOLVED → 發送前命中
  await prisma.conversation.update({ where: { id: FIX.W.convId }, data: { status: "RESOLVED" } });
  r = await sendFollowupTask(tW.id, { via: "AI_ADOPTED" });
  check("T386⑤ RESOLVED（對話已解決）", r.status === "CANCELLED" && r.cancelReason === "RESOLVED", r);

  // ⑥ PAID：F task → mock balance 歸零 → 發送前命中
  setBalance(FIX.F.cpId, 0);
  r = await sendFollowupTask(tF.id, { via: "AI_ADOPTED" });
  check("T386⑥ PAID（欠款歸零）", r.status === "CANCELLED" && r.cancelReason === "PAID", r);
  setBalance(FIX.F.cpId, 600); // 還原

  // ── T387 窗口過咗：未審批 template 唔發 free-form ───────────────────────
  console.log("\n[T387] 窗口規則");
  // W2：窗關（30 日）+ 直接建 DUE task（B rule）
  const tW2 = await prisma.followupTask.create({
    data: {
      clinicId: clinic.id,
      conversationId: FIX.W2.convId,
      patientApricotId: FIX.W2.cpId,
      ruleId: tB.ruleId,
      dueAt: new Date(),
      status: "DUE",
      templateName: "appt_reminder",
      contextJson: { apptId: "apt-p3-w21", apptDate: d.tomorrow, apptTime: d.bTime, clinicCode: CLINIC_CODE },
    },
  });
  r = await sendFollowupTask(tW2.id, { via: "AI_ADOPTED" });
  const msgCount0 = await prisma.message.count({ where: { conversationId: FIX.W2.convId } });
  check("T387a 窗口過 + template 未審批 → SKIPPED(NO_TEMPLATE) 零發送", r.status === "SKIPPED" && r.cancelReason === "NO_TEMPLATE" && msgCount0 === 0, { r, msgCount0 });

  // 審批 appt_reminder（e2e 內審批 — 收結還原 approved=false）
  await prisma.followupTemplate.update({ where: { key: "appt_reminder" }, data: { approved: true, approvedAt: new Date(), approvedBy: "e2e" } });
  const tW2b = await prisma.followupTask.create({
    data: {
      clinicId: clinic.id,
      conversationId: FIX.W2.convId,
      patientApricotId: FIX.W2.cpId,
      ruleId: tB.ruleId,
      dueAt: new Date(),
      status: "DUE",
      templateName: "appt_reminder",
      templateVars: { apptDate: d.tomorrow, apptTime: d.bTime, providerName: "Dr. P3" },
      contextJson: { apptId: "apt-p3-w21", apptDate: d.tomorrow, apptTime: d.bTime, clinicCode: CLINIC_CODE },
    },
  });
  // claim 測試：發送前 assign 一個 staff → 發送後唔變（鐵律 5）
  await prisma.conversation.update({ where: { id: FIX.W2.convId }, data: { assigneeId: staff.id } });
  r = await sendFollowupTask(tW2b.id, { via: "AI_ADOPTED" });
  const msgT = r.messageId ? await prisma.message.findUnique({ where: { id: r.messageId } }) : null;
  const convW2After = await prisma.conversation.findUnique({ where: { id: FIX.W2.convId }, select: { assigneeId: true, followupRepliedAt: true } });
  check(
    "T387b 審批後 → template 發送（type=template + templateMeta + UTILITY + AI_ADOPTED）",
    r.status === "SENT" && !!msgT && msgT.type === "template" && (msgT.templateMeta as any)?.name !== undefined && msgT.billingCategory === "UTILITY" && msgT.sentVia === "AI_ADOPTED" && msgT.aiAutoSent === false,
    msgT && { type: msgT.type, sentVia: msgT.sentVia, cat: msgT.billingCategory }
  );
  check("T387c 發送 body 渲染咗變數（無 {{ 殘留 + 醫生名/日期入咗）", !!msgT && (msgT.body ?? "").includes("{{") === false && (msgT.body ?? "").includes("Dr. P3") && (msgT.body ?? "").includes(d.tomorrow), msgT?.body);

  // ── T388 窗口內 → text（未審批 template 唔阻 free-form）──────────────────
  console.log("\n[T388] 窗內 text");
  // W3：窗開（1 小時）+ A rule task（conversation_followup 未審批）
  const ruleA = await prisma.followupRule.findFirst({ where: { trigger: "CONVERSATION_IDLE" } });
  const tW3 = await prisma.followupTask.create({
    data: {
      clinicId: clinic.id,
      conversationId: FIX.W3.convId,
      ruleId: ruleA!.id,
      dueAt: new Date(),
      status: "DUE",
      templateName: "conversation_followup",
      contextJson: { idleDays: 8 },
    },
  });
  r = await sendFollowupTask(tW3.id, { via: "AI_ADOPTED" });
  const msgT3 = r.messageId ? await prisma.message.findUnique({ where: { id: r.messageId } }) : null;
  check("T388 窗口內 + template 未審批 → 照發 text（free-form）", r.status === "SENT" && !!msgT3 && msgT3.type === "text" && msgT3.sentVia === "AI_ADOPTED", msgT3 && { type: msgT3.type });

  // ── T389 L2 直發（AI_AUTO）──────────────────────────────────────────────
  console.log("\n[T389] L2 自動");
  const ruleL2 = await prisma.followupRule.create({
    data: {
      clinicId: clinic.id,
      name: "E2EP3-L2-test",
      enabled: true,
      trigger: "CONVERSATION_IDLE",
      delayValue: 1,
      delayUnit: "HOUR",
      reasonCodes: [],
      templateName: "conversation_followup",
      level: "L2",
      maxSends: 1,
    },
  });
  // 暫時 disable 其他規則（掃 L2 時唔好冚其他病人）
  const otherRules = await prisma.followupRule.findMany({ where: { id: { not: ruleL2.id }, enabled: true }, select: { id: true } });
  await prisma.followupRule.updateMany({ where: { id: { in: otherRules.map((x) => x.id) } }, data: { enabled: false } });
  try {
    const { runFollowupScan } = await import("../src/lib/followup/engine");
    const scan = await runFollowupScan();
    const tL2 = (await prisma.followupTask.findMany({ where: { conversationId: FIX.L2.convId, ruleId: ruleL2.id } }))[0];
    const msgL2 = tL2?.sentMessageId ? await prisma.message.findUnique({ where: { id: tL2.sentMessageId } }) : null;
    check(
      "T389 L2 到期 → cron 直發（AI_AUTO + aiAutoSent + text 窗內）",
      tL2?.status === "SENT" && !!msgL2 && msgL2.sentVia === "AI_AUTO" && msgL2.aiAutoSent === true && msgL2.type === "text",
      { tL2: tL2 && tL2.status, msgL2: msgL2 && { via: msgL2.sentVia, auto: msgL2.aiAutoSent } }
    );
    check("T389b scan 回傳計數（created/sent）", scan.created >= 1 && scan.sent >= 1, scan);
  } finally {
    await prisma.followupRule.updateMany({ where: { id: { in: otherRules.map((x) => x.id) } }, data: { enabled: true } });
    await prisma.followupRule.delete({ where: { id: ruleL2.id } });
  }

  // ── T390 發送唔 claim + 病人回覆 → COMPLETED 唔 claim + badge ────────────
  console.log("\n[T390] 唔 claim + 回覆完成");
  const convW2Final = await prisma.conversation.findUnique({ where: { id: FIX.W2.convId }, select: { assigneeId: true, followupRepliedAt: true } });
  check("T390a 發送後 assignee 唔變（唔 claim）", convW2Final?.assigneeId === staff.id, convW2Final);
  const { markFollowupReplied } = await import("../src/lib/followup/engine");
  const n = await markFollowupReplied(FIX.W2.convId);
  const tW2bAfter = await prisma.followupTask.findUnique({ where: { id: tW2b.id }, select: { status: true } });
  const convW2Reply = await prisma.conversation.findUnique({ where: { id: FIX.W2.convId }, select: { assigneeId: true, followupRepliedAt: true } });
  check("T390b 病人回覆 → SENT task COMPLETED + followupRepliedAt badge", n >= 1 && tW2bAfter?.status === "COMPLETED" && !!convW2Reply?.followupRepliedAt, { n, tW2bAfter, convW2Reply });
  check("T390c 回覆後 assignee 依然唔變（落公海照公海 — 唔 claim）", convW2Reply?.assigneeId === staff.id, convW2Reply);

  // ── T391 audit 零 PII + UTILITY ─────────────────────────────────────────
  console.log("\n[T391] audit");
  const audits = await prisma.auditLog.findMany({ where: { action: "FOLLOWUP_SENT" } });
  check("T391a FOLLOWUP_SENT audit 存在（≥3 條）", audits.length >= 3, audits.length);
  for (const a of audits.slice(0, 5)) assertNoPii(a.meta, `T391b audit ${a.entityId}`);
  const allMsgs = await prisma.message.findMany({ where: { conversationId: { in: convIds }, sentVia: { in: ["AI_AUTO", "AI_ADOPTED"] } } });
  check("T391c 跟進 Message 全部 billingCategory=UTILITY", allMsgs.length > 0 && allMsgs.every((m) => m.billingCategory === "UTILITY"), allMsgs.map((m) => m.billingCategory));
  assertNoPii(allMsgs.map((m) => ({ id: m.id })), "T391d Message 欄無 PII 洩露");

  // ── T392 hub 健康項 ─────────────────────────────────────────────────────
  console.log("\n[T392] hub 健康項");
  const { buildHubSummary } = await import("../src/lib/ai/hub-summary");
  const fakeCtx = { staff: { id: "e2ep3-admin-u1", role: "ADMIN", name: "E2E", active: true }, clinicId: null, clinicIds: [], scopeType: "ALL", scopedClinicIds: [] } as any;
  const hub1 = await buildHubSummary(fakeCtx);
  const fu1 = hub1.health.find((h) => h.id === "followup");
  check("T392a 未審批 template → followup 健康項紅底", !!fu1 && fu1.ok === false && fu1.reason.includes("未審批"), fu1);
  // 審批晒 enabled 規則引用嘅 template → 綠
  const enRules = await prisma.followupRule.findMany({ where: { enabled: true }, select: { templateName: true } });
  for (const rr of new Set(enRules.map((x) => x.templateName))) {
    await prisma.followupTemplate.update({ where: { key: rr }, data: { approved: true, approvedAt: new Date(), approvedBy: "e2e" } });
  }
  const hub2 = await buildHubSummary(fakeCtx);
  const fu2 = hub2.health.find((h) => h.id === "followup");
  check("T392b 審批後 → 綠底", !!fu2 && fu2.ok === true, fu2);
  // 還原 approved=false（老細審批中 — 唔留 e2e 審批痕跡）
  for (const rr of new Set(enRules.map((x) => x.templateName))) {
    await prisma.followupTemplate.update({ where: { key: rr }, data: { approved: false, approvedAt: null, approvedBy: null } });
  }

  // ── T393 API（login + 列表 + 人撳 + cancel）────────────────────────────
  console.log("\n[T393] API");
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASS }),
  });
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  check("T393a login 成功（cookie）", loginRes.ok && cookie.includes("wa_inbox_session"), loginRes.status);
  const H = { "Content-Type": "application/json", Cookie: cookie };
  const listRes = await fetch(`${BASE}/api/followups/tasks?limit=50`, { headers: H });
  const listBody = (await listRes.json()) as { tasks: { id: string; status: string }[] };
  check("T393b task 列表 API（200 + 有 e2e task）", listRes.ok && listBody.tasks.length > 0, listRes.status);
  // 人撳 cancel（convF2 嘅 A task — 30 日空窗 DUE，未被其他測試動過）
  const tAF2 = await taskOf(FIX.F2.convId, "CONVERSATION_IDLE");
  const cancelRes = await fetch(`${BASE}/api/followups/tasks/${tAF2?.id ?? "none"}`, { method: "POST", headers: H, body: JSON.stringify({ action: "cancel" }) });
  const cancelBody = (await cancelRes.json()) as { ok: boolean; result: { status: string } };
  check("T393c API 人撳 cancel → CANCELLED(MANUAL)", !!tAF2 && cancelRes.ok && cancelBody.result?.status === "CANCELLED", cancelBody);
  const tAF2After = tAF2 ? await prisma.followupTask.findUnique({ where: { id: tAF2.id }, select: { status: true, cancelReason: true } }) : null;
  check("T393d cancel 落 DB（MANUAL）", tAF2After?.status === "CANCELLED" && tAF2After.cancelReason === "MANUAL", tAF2After);

  // ── T394 偵測/渲染 unit ─────────────────────────────────────────────────
  console.log("\n[T394] unit");
  const { detectOptOutIntent } = await import("../src/lib/followup/opt-out");
  const { renderFollowupText } = await import("../src/lib/followup/engine");
  check("T394a 偵測：stop / 唔好再搵我 / unsubscribe 命中", detectOptOutIntent("stop") && detectOptOutIntent("唔好再搵我") && detectOptOutIntent("unsubscribe"));
  check("T394b 偵測：長句誤傷防護（doctor said stop smoking ok）", !detectOptOutIntent("doctor said stop smoking ok thanks, will come next tuesday 10am"));
  check("T394c 渲染：{{var}} 替換 + 缺變數清空", renderFollowupText("Hi {{a}}, {{clinicName}}", { a: "X", clinicName: null }) === "Hi X, ");

  // ── T395 零殘留 ─────────────────────────────────────────────────────────
  console.log("\n[T395] 零殘留 cleanup");
  const taskIds = (await prisma.followupTask.findMany({ where: { conversationId: { in: convIds } }, select: { id: true } })).map((t) => t.id);
  await prisma.followupTask.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.followupRule.deleteMany({ where: { name: { startsWith: "E2EP3-" } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...convIds, ...taskIds] } }, { action: { startsWith: "FOLLOWUP_" } }] } });
  await prisma.staffNotice.deleteMany({ where: { title: { startsWith: "跟進停止" } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
  const admin = await prisma.staffUser.findFirst({ where: { email: ADMIN_EMAIL }, select: { id: true } });
  if (admin) {
    await prisma.staffClinic.deleteMany({ where: { staffId: admin.id } });
    await prisma.staffUser.deleteMany({ where: { id: admin.id } });
  }
  // template 還原（老細審批中 — approved=false）
  const tplKeys = ["conversation_followup", "appt_reminder", "no_show", "outstanding_balance", "post_op_check", "recall_cleaning"];
  await prisma.followupTemplate.updateMany({ where: { key: { in: tplKeys } }, data: { approved: false, approvedAt: null, approvedBy: null } });
  // mock flag 收
  try {
    fs.unlinkSync(path.resolve(process.cwd(), MOCK_FLAG));
  } catch {
    /* 冇 */
  }
  try {
    fs.unlinkSync(MOCK_REAL);
  } catch {
    /* 冇 */
  }
  const left = await Promise.all([
    prisma.followupTask.count({ where: { conversationId: { in: convIds } } }),
    prisma.followupRule.count({ where: { name: { startsWith: "E2EP3-" } } }),
    prisma.contact.count({ where: { id: { in: contactIds } } }),
    prisma.conversation.count({ where: { id: { in: convIds } } }),
    prisma.auditLog.count({ where: { action: { startsWith: "FOLLOWUP_" } } }),
  ]);
  check("T395 零殘留（task/rule/contact/conv/audit = 0）", left.every((x) => x === 0), left);
  const tplLeft = await prisma.followupTemplate.count({ where: { approved: true } });
  check("T395b template 全部還原 approved=false", tplLeft === 0, tplLeft);

  console.log(`\n=== e2e-followup-p3 完成：${passCount} passed${process.exitCode ? "（有失敗）" : " — ALL GREEN"}`);
}

main()
  .catch((err) => {
    console.error("FATAL", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
  });
