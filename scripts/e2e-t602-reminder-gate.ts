/**
 * e2e-t602-reminder-gate — cwi-final S0-8：legacy 自動提醒永久關（D-1 / C-7 🔴）
 *
 * T602（施工單）：REMINDER_AUTO_SEND 未設 → seed 一張 CONFIRMED 且喺提醒窗口嘅 BookingRequest
 *   → 跑 reminder-scan → job 回 skipped、零 OUT、remindedAt 仍 null。
 *
 * 背景：v3 原則「cron 唔發訊息」— legacy T-24h 自動提醒（Phase B）永久關；
 * 預約提醒改用 follow-up B1 建議規則（員工撳先發）。gate 喺 cron.worker case 層
 * （REMINDER_AUTO_SEND !== "1" → log + return skipped）— 零產出分支有 log（D-1 鐵律 4）。
 *
 * 驗證路徑：enqueue 真 job（pnpm e2e:cron reminder-scan → 共享 cron queue）→
 *   運行中 dev worker 處理 → poll worker log（/tmp/wa-worker-dev.log）skip 行 + DB 狀態。
 *
 * 用法（repo root）：pnpm tsx scripts/e2e-t602-reminder-gate.ts
 * 輸出：T602-OK / T602-FAIL: <n>
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { cronQueue } from "../src/lib/queue";

try {
  process.loadEnvFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"));
} catch {
  /* 靠 process env */
}

const WORKER_LOG = "/tmp/wa-worker-dev.log";
const CLINIC_ID = "e2ev3clinic0000000000001"; // 24 位 cuid 形 — 同 e2e-followup-v3 共用（冪等 upsert）
const CT_ID = "e2et602contact00000000001";
const CONV_ID = "e2et602conv000000000001";
const BR_ID = "e2et602br00000000000001";

let FAILS = 0;
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(name);
  else fail(`${name}${detail !== undefined ? "（" + JSON.stringify(detail).slice(0, 300) + "）" : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

async function cleanupFixture(): Promise<void> {
  await prisma.bookingRequest.deleteMany({ where: { id: BR_ID } });
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" = '${CONV_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE id = '${CONV_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE id = '${CT_ID}'`);
}

async function main(): Promise<void> {
  console.log("[setup] seed 窗口內 CONFIRMED BookingRequest...");
  check("T602 pre：REMINDER_AUTO_SEND 未設/≠1（gate 前提）", process.env.REMINDER_AUTO_SEND !== "1", process.env.REMINDER_AUTO_SEND);
  const workerUp = spawnSync("pgrep", ["-f", "[w]orkers/index.ts"], { encoding: "utf8" }).stdout.trim() !== "";
  check("T602 pre：dev worker 運行中", workerUp);
  if (!workerUp) throw new Error("worker 冇起 — 無法驗證 cron gate（先起 pnpm worker）");

  await cleanupFixture();
  await prisma.clinic.upsert({
    where: { id: CLINIC_ID },
    update: { code: "E2EV3" },
    create: { id: CLINIC_ID, code: "E2EV3", name: "V3 E2E 診所", waPhoneNumberId: "109990000000099", waDisplayNumber: "+852 3001 9003" },
  });
  const inboundAt = new Date(Date.now() - 3_600_000);
  await prisma.contact.create({ data: { id: CT_ID, clinicId: CLINIC_ID, waId: "95000022", profileName: "T602 提醒張", labels: [] } });
  await prisma.conversation.create({
    data: { id: CONV_ID, contactId: CT_ID, clinicId: CLINIC_ID, status: "OPEN", lastInboundAt: inboundAt, lastMessageAt: inboundAt },
  });
  // now+24h 嘅 HK wall-clock（同 reminder.ts dayStrs 口徑：UTC+8）— 必落 23–25h 窗口
  const hk = new Date(Date.now() + 24 * 3_600_000 + 8 * 3_600_000);
  const reqDate = hk.toISOString().slice(0, 10);
  const reqTime = `${String(hk.getUTCHours()).padStart(2, "0")}:${String(hk.getUTCMinutes()).padStart(2, "0")}`;
  await prisma.bookingRequest.create({
    data: {
      id: BR_ID,
      conversationId: CONV_ID,
      clinicId: CLINIC_ID,
      flowToken: "e2et602-flow-01",
      providerApricotId: "mock-pract-E2EV3-1",
      providerName: "T602 E2E 醫生",
      requestedDate: reqDate,
      requestedTime: reqTime,
      status: "CONFIRMED",
      apricotApptId: "e2et602-appt-1",
    },
  });
  ok(`fixture：CONFIRMED + apricotApptId + 窗口 ${reqDate} ${reqTime}（remindedAt=null）`);

  const logSizeBefore = fs.existsSync(WORKER_LOG) ? fs.statSync(WORKER_LOG).size : 0;
  const outBefore = await prisma.message.count({ where: { conversationId: CONV_ID, direction: "OUT" } });

  try {
    // 直接 enqueue（同 shared cron queue；運行中 worker 食）— 用 job return value 做主斷言
    // （log 行受 stdout flush 延遲影響，只做輔助）
    const job = await cronQueue.add("reminder-scan", {});
    check("T602a reminder-scan job enqueue 成功", !!job?.id, { id: job?.id });
    let jstate = "waiting";
    let jret: unknown = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      jstate = await job.getState();
      if (jstate === "completed" || jstate === "failed") {
        const fresh = await cronQueue.getJob(job.id as string); // 重讀 — job 例上嘅 returnvalue 未必已同步
        jret = fresh?.returnvalue ?? job.returnvalue;
        break;
      }
    }
    check("T602b job 回 skipped（REMINDER_AUTO_SEND off — D-1）", jstate === "completed" && (jret as any)?.skipped === "REMINDER_AUTO_SEND off", { jstate, jret });
    // 輔助：worker log 零產出分支必 log（D-1 鐵律 4）— flush 可延遲，最多等 30s
    let skipSeen = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        if (fs.readFileSync(WORKER_LOG).subarray(logSizeBefore).toString("utf8").includes("reminder-scan skipped")) {
          skipSeen = true;
          break;
        }
      } catch {
        /* log 未寫到 */
      }
    }
    check("T602b2 worker log 有「reminder-scan skipped」（零產出必 log）", skipSeen);

    const outAfter = await prisma.message.count({ where: { conversationId: CONV_ID, direction: "OUT" } });
    check("T602c 零 OUT Message（窗口內 CONFIRMED 單都唔發）", outAfter === outBefore && outAfter === 0, { outBefore, outAfter });
    const br = await prisma.bookingRequest.findUnique({ where: { id: BR_ID }, select: { remindedAt: true, status: true } });
    check("T602d remindedAt 仍 null（零提醒）", br?.remindedAt === null && br?.status === "CONFIRMED", br);
  } finally {
    await cleanupFixture();
    const leftover = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ((SELECT count(*) FROM "Contact" WHERE id = '${CT_ID}')
        + (SELECT count(*) FROM "BookingRequest" WHERE id = '${BR_ID}')
        + (SELECT count(*) FROM "Message" WHERE "conversationId" = '${CONV_ID}'))::int AS n`
    );
    check("cleanup 後零殘留", leftover[0]?.n === 0);
  }

  if (FAILS > 0) {
    console.log(`T602-FAIL: ${FAILS} 項失敗`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("T602-OK");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("T602-FAIL:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
