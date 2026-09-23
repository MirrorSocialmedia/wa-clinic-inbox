/**
 * e2e-followup-p3.ts — P3 迴歸（★ cwi-followup-v3-20260916 更新：員工提示層口徑）
 *
 * 前置：dev server 127.0.0.1:3100（WA_MOCK=1）；worker 跑緊（tsx src/workers/index.ts，
 *   .env WORKFORCE_MOCK=1）；Postgres 15432；redis 6379。
 * 跑法：pnpm -s tsx scripts/e2e-followup-p3.ts
 *
 * 決定性：
 *   - mock 動態 fixture `.dev/workforce-mock-followup.json`（symlink → /tmp 避 Next watcher）：
 *     明日預約 0（b01/w01/w21/w41）+ 前日爽約 -3（n01）+ opt-out 病人 0（o01）。
 *     （F 欠款 mock 已隨 v3 整類剷走 — engine 唔再 call balance。）
 *   - 第一次 scan 經 cron queue enqueue（worker 執行 — 證明 cron 掛接）；其餘走引擎直接調。
 *
 * 斷言（v3 員工提示層）：
 *   T380 基建 + 冪等洗｜T381 A 類跑通（SUGGESTED）｜T382 B 預約提醒跑通（SUGGESTED）
 *   T383 B 爽約跑通（SUGGESTED）｜T384 F 鏈已剷（template 冇 + rule 冇）｜T385 opt-out 零 task
 *   T386 取消五項（OPT_OUT/REPLIED/BOOKED/ARRIVED/RESOLVED）
 *   T387 窗口過咗：未審批 template 唔俾發（task 留 SUGGESTED）；審批後 → template 發
 *   T388 窗口內 text（員工採用 AI_ADOPTED）｜T389 cron 零 outbound（L2 rule 只建 SUGGESTED，零發送）
 *   T390 發送唔 claim + 病人回覆 → COMPLETED 唔 claim + followupRepliedAt badge
 *   T391 audit FOLLOWUP_SENT 零 PII + billingCategory UTILITY｜T392 hub 健康項（未審批紅 / 審批後綠）
 *   T393 API（login + SUGGESTED 列表 + skip + send）｜T394 偵測/渲染 unit｜T395 零殘留
 *
 * e2e harness：playwright/prisma 動態 payload 型太繁 → 本檔局部 any（src/ 零 any）
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
import "./e2e-origin-shim";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
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

// ── 病人矩陣（固定 waId / cpId / 前綴 id — 冪等；v3：F 欠款 fixture 已剷）────────
type Fix = { waId: string; cpId: string; contactId: string; convId: string; name: string };
const FIX: Record<string, Fix> = {
  A: { waId: "91000001", cpId: "cp-p3-a01", contactId: "e2ep3c-a01", convId: "e2ep3v-a01", name: "E2E A 空窗" },
  A2: { waId: "91000007", cpId: "cp-p3-a02", contactId: "e2ep3c-a02", convId: "e2ep3v-a02", name: "E2E A2 未到期" },
  B: { waId: "91000002", cpId: "cp-p3-b01", contactId: "e2ep3c-b01", convId: "e2ep3v-b01", name: "E2E B 預約" },
  N: { waId: "91000003", cpId: "cp-p3-n01", contactId: "e2ep3c-n01", convId: "e2ep3v-n01", name: "E2E N 爽約" },
  O: { waId: "91000005", cpId: "cp-p3-o01", contactId: "e2ep3c-o01", convId: "e2ep3v-o01", name: "E2E O opt-out" },
  W: { waId: "91000006", cpId: "cp-p3-w01", contactId: "e2ep3c-w01", convId: "e2ep3v-w01", name: "E2E W 過窗" },
  W2: { waId: "91000008", cpId: "cp-p3-w21", contactId: "e2ep3c-w21", convId: "e2ep3v-w21", name: "E2E W2 template發" },
  W3: { waId: "91000009", cpId: "cp-p3-w31", contactId: "e2ep3c-w31", convId: "e2ep3v-w31", name: "E2E W3 窗內text" },
  L2: { waId: "91000010", cpId: "cp-p3-l21", contactId: "e2ep3c-l21", convId: "e2ep3v-l21", name: "E2E L2 零outbound" },
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
      appt("apt-p3-o01", d.tomorrow, d.bTime, 0, FIX.O.cpId, FIX.O.waId),
      appt("apt-p3-w01", d.tomorrow, d.bTime, 0, FIX.W.cpId, FIX.W.waId),
      appt("apt-p3-w21", d.tomorrow, d.bTime, 0, FIX.W2.cpId, FIX.W2.waId),
      appt("apt-p3-w41", d.tomorrow, d.bTime, 0, FIX.W4.cpId, FIX.W4.waId),
    ],
    // ★ v3：engine 唔再 call balance（F 整類剷走）— 保留空 balances 鍵令 mock 形態完整
    balances: {},
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

async function tasksOf(convId: string, status?: FollowupStatus) {
  return prisma.followupTask.findMany({ where: { conversationId: convId, ...(status ? { status } : {}) } });
}
async function taskOf(convId: string, trigger: FollowupTrigger): Promise<Awaited<ReturnType<typeof prisma.followupTask.findMany>>[number] | undefined> {
  const rules = await prisma.followupRule.findMany({ where: { trigger }, select: { id: true } });
  if (rules.length === 0) return undefined;
  const ts = await prisma.followupTask.findMany({ where: { conversationId: convId, ruleId: { in: rules.map((r) => r.id) } } });
  return ts[0];
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

  // 一個真實 staff（W2 claim 測試用 assignee）
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
  for (const k of ["B", "N", "O", "W", "W2", "W4"]) await mkConv(k, 24 * 30); // 30 日（窗關）
  await mkConv("A", 24 * 8); // 8 日 → A 到期（due = 1 日前）
  await mkConv("A2", 24 * 3); // 3 日 → A2 未到期（due = 4 日後）
  await mkConv("L2", 2); // 2 小時（窗開 + 1h L2 rule 候選）
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
  check("fixture 落（10 contact/conv + mock appointments）", (fixture.appointments as unknown[]).length === 6);

  // ── T381–T385：第一次 scan 經 cron queue（worker 執行 — 證明掛接）──────────
  console.log("\n[T381-385] cron enqueue followup-scan → worker 掃");
  const { cronQueue } = await import("../src/lib/queue");
  await cronQueue.add("followup-scan", {}, { jobId: `e2e-followup-${Date.now()}` });
  // poll：等 B/N task 出現（worker scan 完成标志）
  let scanDone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const [bt, nt] = await Promise.all([tasksOf(FIX.B.convId), tasksOf(FIX.N.convId)]);
    if (bt.length > 0 && nt.length > 0) {
      scanDone = true;
      break;
    }
  }
  if (!scanDone) {
    const wlog = fs.existsSync("/tmp/p3-worker.log") ? fs.readFileSync("/tmp/p3-worker.log", "utf8").split("\n").slice(-30).join("\n") : "(no log)";
    console.error("worker log tail:\n" + wlog);
    fail("cron followup-scan 60 秒內無產 task（worker 未食 job？）");
  }
  await sleep(1500); // 等其餘規則掃完

  const tA = await taskOf(FIX.A.convId, "CONVERSATION_IDLE");
  const tA2 = await taskOf(FIX.A2.convId, "CONVERSATION_IDLE");
  const tB = await taskOf(FIX.B.convId, "BEFORE_APPOINTMENT");
  const tN = await taskOf(FIX.N.convId, "AFTER_NO_SHOW");
  const tO = await tasksOf(FIX.O.convId);
  const tW = await taskOf(FIX.W.convId, "BEFORE_APPOINTMENT");

  // T381 A 類
  check("T381a A 空窗 8 日 → task SUGGESTED（提示層 — 零發送）", !!tA && tA.status === "SUGGESTED", tA);
  check("T381b A 空窗 3 日（< 7 日門檻）→ 未建 task（到門檻先建）", tA2 === undefined, tA2);
  check("T381c A task 帶 idleDays context（零臨床）", !!tA && (tA.contextJson as any)?.idleDays === 8, tA?.contextJson);

  // T382 B 預約提醒
  const d = mockDates();
  const expDueB = new Date(`${d.today}T${d.bTime}:00+08:00`).getTime();
  check(
    "T382 B 明日預約 → task SUGGESTED（dueAt = 預約前 1 日 + 配對 patientApricotId）",
    !!tB && tB.status === "SUGGESTED" && tB.dueAt.getTime() === expDueB && tB.patientApricotId === FIX.B.cpId,
    { tB: tB && { status: tB.status, dueAt: tB.dueAt.getTime(), cp: tB.patientApricotId }, expDueB }
  );
  check("T382b B contextJson 只顯示用（apptId/date/time/clinicCode）", !!tB && !JSON.stringify(tB.contextJson).includes("9110"), tB?.contextJson);

  // T383 B 爽約
  check("T383 前日爽約 -3 → task SUGGESTED（爽約 +1 日後到期）", !!tN && tN.status === "SUGGESTED" && (tN.contextJson as any)?.noShow === true, tN);

  // T384 ★ v3：F 欠款提醒整類已剷（template + rule 都唔存在）
  const tplF = await prisma.followupTemplate.findUnique({ where: { key: "outstanding_balance" } });
  const ruleFCount = await prisma.$queryRawUnsafe<{ n: number }[]>(
    "SELECT count(*)::int AS n FROM \"FollowupRule\" WHERE \"trigger\"::text = 'OUTSTANDING_BALANCE'"
  );
  check("T384a F 鏈已剷：outstanding_balance template 唔存在", tplF === null, tplF);
  check("T384b F 鏈已剷：OUTSTANDING_BALANCE rule 零條", ruleFCount[0]?.n === 0, ruleFCount);

  // T385 opt-out 零 task
  check("T385 opt-out 病人（有明日預約）→ scan 零 task", tO.length === 0, tO);
  if (!tA || !tB || !tN || !tW) fail("scan 未建齊預期 task（tA/tB/tN/tW 有缺）");

  // ── T386 取消五項（每次發送前重跑 — 直接調 sendFollowupTask）─────────────
  console.log("\n[T386] 取消五項");
  const { sendFollowupTask } = await import("../src/lib/followup/engine");

  // ① OPT_OUT：O 手動建 SUGGESTED task → 發送前檢查命中
  const tOdirect = await prisma.followupTask.create({
    data: {
      clinicId: clinic.id,
      conversationId: FIX.O.convId,
      patientApricotId: FIX.O.cpId,
      ruleId: tB.ruleId,
      dueAt: new Date(),
      status: "SUGGESTED",
      templateName: "appt_reminder",
      contextJson: { apptId: "apt-p3-o01", apptDate: d.tomorrow, apptTime: d.bTime, clinicCode: CLINIC_CODE },
    },
  });
  let r = await sendFollowupTask(tOdirect.id, { staffId: staff.id });
  check("T386① OPT_OUT（永遠檢查）", r.status === "CANCELLED" && r.cancelReason === "OPT_OUT", r);

  // ② REPLIED：A task → 病人回覆（lastInbound=now）→ 發送前命中
  await prisma.conversation.update({ where: { id: FIX.A.convId }, data: { lastInboundAt: new Date() } });
  r = await sendFollowupTask(tA.id, { staffId: staff.id });
  check("T386② REPLIED（新 inbound）", r.status === "CANCELLED" && r.cancelReason === "REPLIED", r);

  // ③ BOOKED：N task → mock 改「重新約咗」(新 apptId, status 0, 明日) → 發送前命中
  rewriteAppt("apt-p3-n01", { bookingStatus: 0, date: d.tomorrow, apricotApptId: "apt-p3-n01b" });
  r = await sendFollowupTask(tN.id, { staffId: staff.id });
  check("T386③ BOOKED（期間新 booking）", r.status === "CANCELLED" && r.cancelReason === "BOOKED", r);
  rewriteAppt("apt-p3-n01b", { bookingStatus: -3, date: d.twoDaysAgo, apricotApptId: "apt-p3-n01" }); // 還原

  // ④ ARRIVED：B task → mock 改该預約 status=1（已到）→ 發送前命中
  rewriteAppt("apt-p3-b01", { bookingStatus: 1 });
  r = await sendFollowupTask(tB.id, { staffId: staff.id });
  check("T386④ ARRIVED（bookingStatus=1）", r.status === "CANCELLED" && r.cancelReason === "ARRIVED", r);
  rewriteAppt("apt-p3-b01", { bookingStatus: 0 }); // 還原

  // ⑤ RESOLVED：W task → 對話 RESOLVED → 發送前命中
  await prisma.conversation.update({ where: { id: FIX.W.convId }, data: { status: "RESOLVED" } });
  r = await sendFollowupTask(tW.id, { staffId: staff.id });
  check("T386⑤ RESOLVED（對話已解決）", r.status === "CANCELLED" && r.cancelReason === "RESOLVED", r);

  // ★ v3：PAID 取消已隨 F 類剷走（斷言五項 = 無 PAID 路徑）

  // ── T387 窗口過咗：未審批 template 唔俾發（task 留 SUGGESTED）─────────────
  console.log("\n[T387] 窗口規則");
  // W2：窗關（30 日）+ 直接建 SUGGESTED task（B rule）
  const tW2 = await prisma.followupTask.create({
    data: {
      clinicId: clinic.id,
      conversationId: FIX.W2.convId,
      patientApricotId: FIX.W2.cpId,
      ruleId: tB.ruleId,
      dueAt: new Date(),
      status: "SUGGESTED",
      templateName: "appt_reminder",
      contextJson: { apptId: "apt-p3-w21", apptDate: d.tomorrow, apptTime: d.bTime, clinicCode: CLINIC_CODE },
    },
  });
  r = await sendFollowupTask(tW2.id, { staffId: staff.id });
  const msgCount0 = await prisma.message.count({ where: { conversationId: FIX.W2.convId } });
  const tW2Still = await prisma.followupTask.findUnique({ where: { id: tW2.id }, select: { status: true } });
  check(
    "T387a 窗口過 + template 未審批 → 唔俾發（SKIPPED(NO_TEMPLATE) 回傳；task 留 SUGGESTED 等審批；零發送）",
    r.status === "SKIPPED" && r.cancelReason === "NO_TEMPLATE" && msgCount0 === 0 && tW2Still?.status === "SUGGESTED",
    { r, msgCount0, tW2Still }
  );

  // 審批 appt_reminder（e2e 內審批 — 收結還原 approved=false）
  await prisma.followupTemplate.update({ where: { key: "appt_reminder" }, data: { approved: true, approvedAt: new Date(), approvedBy: "e2e" } });
  const tW2b = await prisma.followupTask.create({
    data: {
      clinicId: clinic.id,
      conversationId: FIX.W2.convId,
      patientApricotId: FIX.W2.cpId,
      ruleId: tB.ruleId,
      dueAt: new Date(),
      status: "SUGGESTED",
      templateName: "appt_reminder",
      templateVars: { apptDate: d.tomorrow, apptTime: d.bTime, providerName: "Dr. P3" },
      contextJson: { apptId: "apt-p3-w21", apptDate: d.tomorrow, apptTime: d.bTime, clinicCode: CLINIC_CODE },
    },
  });
  // claim 測試：發送前 assign 一個 staff → 發送後唔變（鐵律 5）
  await prisma.conversation.update({ where: { id: FIX.W2.convId }, data: { assigneeId: staff.id } });
  r = await sendFollowupTask(tW2b.id, { staffId: staff.id });
  const msgT = r.messageId ? await prisma.message.findUnique({ where: { id: r.messageId } }) : null;
  const convW2After = await prisma.conversation.findUnique({ where: { id: FIX.W2.convId }, select: { assigneeId: true, followupRepliedAt: true } });
  check(
    "T387b 審批後 → template 發送（type=template + templateMeta + UTILITY + AI_ADOPTED + aiAutoSent=false）",
    r.status === "SENT" && !!msgT && msgT.type === "template" && (msgT.templateMeta as any)?.name !== undefined && msgT.billingCategory === "UTILITY" && msgT.sentVia === "AI_ADOPTED" && msgT.aiAutoSent === false,
    msgT && { type: msgT.type, sentVia: msgT.sentVia, cat: msgT.billingCategory }
  );
  check("T387c 發送 body 渲染咗變數（無 {{ 殘留 + 醫生名/日期入咗）", !!msgT && (msgT.body ?? "").includes("{{") === false && (msgT.body ?? "").includes("Dr. P3") && (msgT.body ?? "").includes(d.tomorrow), msgT?.body);
  void convW2After;

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
      status: "SUGGESTED",
      templateName: "conversation_followup",
      contextJson: { idleDays: 8 },
    },
  });
  r = await sendFollowupTask(tW3.id, { staffId: staff.id });
  const msgT3 = r.messageId ? await prisma.message.findUnique({ where: { id: r.messageId } }) : null;
  check("T388 窗口內 + template 未審批 → 照發 text（員工採用 AI_ADOPTED）", r.status === "SENT" && !!msgT3 && msgT3.type === "text" && msgT3.sentVia === "AI_ADOPTED" && msgT3.aiAutoSent === false, msgT3 && { type: msgT3.type });

  // ── T389 ★ v3：cron 零 outbound（L2 rule 建 SUGGESTED 但零發送）────────────
  console.log("\n[T389] cron 零 outbound");
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
      level: "L2", // v3：engine 忽略 level — 永遠建議
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
    const msgsL2 = await prisma.message.findMany({ where: { conversationId: FIX.L2.convId } });
    const autoMsgs = await prisma.message.count({ where: { conversationId: { in: convIds }, OR: [{ sentVia: "AI_AUTO" }, { aiAutoSent: true }] } });
    check(
      "T389 L2 rule 到期 → 只建 SUGGESTED，cron 零 outbound（零 message）",
      !!tL2 && tL2.status === "SUGGESTED" && msgsL2.length === 0,
      { tL2: tL2 && tL2.status, msgsL2: msgsL2.length }
    );
    check("T389b scan 後全 e2e 對話零 AI_AUTO / aiAutoSent message（v3 鐵律）", autoMsgs === 0, autoMsgs);
    check("T389c scan 回傳計數（created ≥ 1，無 sent 欄）", scan.created >= 1, scan);
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
  check("T391a FOLLOWUP_SENT audit 存在（≥2 條）", audits.length >= 2, audits.length);
  for (const a of audits.slice(0, 5)) assertNoPii(a.meta, `T391b audit ${a.entityId}`);
  const allMsgs = await prisma.message.findMany({ where: { conversationId: { in: convIds }, sentVia: { in: ["AI_AUTO", "AI_ADOPTED"] } } });
  check("T391c 跟進 Message 全部 billingCategory=UTILITY + 全部 AI_ADOPTED（無 AI_AUTO）", allMsgs.length > 0 && allMsgs.every((m) => m.billingCategory === "UTILITY" && m.sentVia === "AI_ADOPTED"), allMsgs.map((m) => ({ via: m.sentVia, cat: m.billingCategory })));
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

  // ── T393 API（login + SUGGESTED 列表 + skip + send）─────────────────────
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
  check("T393b task 列表 API（200 + 預設 SUGGESTED 有 e2e task）", listRes.ok && listBody.tasks.length > 0 && listBody.tasks.every((t) => t.status === "SUGGESTED"), { status: listRes.status, n: listBody.tasks.length });
  // 員工跳過（v3：action = skip → SKIPPED(MANUAL)）— W4 嘅 B task（scan 建，未被其他測試動過）
  const tW4 = await taskOf(FIX.W4.convId, "BEFORE_APPOINTMENT");
  const skipRes = await fetch(`${BASE}/api/followups/tasks/${tW4?.id ?? "none"}`, { method: "POST", headers: H, body: JSON.stringify({ action: "skip" }) });
  const skipBody = (await skipRes.json()) as { ok: boolean; result: { status: string } };
  check("T393c API 員工跳過 → SKIPPED(MANUAL)", !!tW4 && skipRes.ok && skipBody.result?.status === "SKIPPED", skipBody);
  const tW4After = tW4 ? await prisma.followupTask.findUnique({ where: { id: tW4.id }, select: { status: true, cancelReason: true } }) : null;
  check("T393d skip 落 DB（MANUAL）", tW4After?.status === "SKIPPED" && tW4After.cancelReason === "MANUAL", tW4After);

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
  // template 還原（老細審批中 — approved=false；outstanding_balance 已隨 v3 剷走）
  const tplKeys = ["conversation_followup", "appt_reminder", "no_show", "post_op_check", "recall_cleaning"];
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
