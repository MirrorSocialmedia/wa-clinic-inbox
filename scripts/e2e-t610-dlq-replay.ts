/**
 * ★ cwi-final S1-1a — T610：DLQ e2e（dev 環境；15432 stop/start 只限本 test 時段）。
 *
 * Case A（短暫 stop ~20s）：3 條 webhook 入 DB 死時段 → job retry（attempts 8）→ PG 還原後成功
 *   → 訊息入 DB、DLQ 零新增（未達最終失敗）。
 * Case B（stop ~6 分鐘）：3 條 webhook → job 最終失敗（~4.2 分鐘 < 6 分鐘）→ DLQ write retry loop
 *   跨過 PG 重啟 → DLQ 3 條 + inbound_failed alert（1 條，冪等）→ replay CLI → 3 條訊息入 DB、
 *   無重複（WebhookEvent claim 冪等）。
 *
 * 前置（唔滿足 = FATAL，唔會 stop PG）：PG 15432 running、dev server 3100 up、worker running、
 * MEDIA_ENC_KEY 已設。跑前另需（人工）：冇其他 e2e 跑緊（/tmp 最新 log >10 分鐘）。
 *
 * 跑法：pnpm tsx scripts/e2e-t610-dlq-replay.ts（總時長 ~13 分鐘；跑完 process.exit）
 * 鐵律：15432 只准本 test 時段停；finally 一定還原 + 驗證；log 零病人原文（只 wamid/計數）。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { execSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prisma from "../src/lib/prisma";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PG_PORT = 15432;
const PGDATA = path.join(ROOT, ".dev/pgdata");
let failures = 0;
function check(name: string, ok: boolean, extra?: unknown): void {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${ok ? "" : ` ${JSON.stringify(extra ?? null)}`}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pgCtl(): string {
  const pnpmDir = path.join(ROOT, "node_modules/.pnpm");
  const dirs = readdirSync(pnpmDir).filter((d) => d.startsWith("@embedded-postgres+linux-x64@"));
  if (dirs.length === 0) throw new Error("搵唔到 @embedded-postgres/linux-x64 pg_ctl");
  return path.join(pnpmDir, dirs[dirs.length - 1], "node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl");
}
function pgReady(): boolean {
  try {
    execSync(`pg_isready -h 127.0.0.1 -p ${PG_PORT}`, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
function sh(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, stdio: "pipe", timeout: 120_000 }).toString().trim();
}

async function waitMessages(wamids: string[], timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const n = await prisma.message.count({ where: { waMessageId: { in: wamids } } });
    if (n >= wamids.length) return n;
    if (Date.now() - t0 > timeoutMs) return n;
    await sleep(5000);
  }
}
async function waitDlq(count: number, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const n = await prisma.deadLetter.count({ where: { queue: "inbound" } });
    if (n >= count) return n;
    if (Date.now() - t0 > timeoutMs) return n;
    await sleep(5000);
  }
}

async function main(): Promise<void> {
  console.log("[T610] DLQ e2e（15432 stop 只限本 test）");

  // ── 0. 前置（FATAL 先 abort，唔 stop PG） ─────────────────────────────
  if (!pgReady()) {
    console.error("FATAL: PG 15432 未 running — abort（唔會 stop 任何嘢）");
    process.exit(1);
  }
  const serverUp = sh("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/healthz").startsWith("2");
  if (!serverUp) {
    console.error("FATAL: dev server 3100 /healthz 唔 2xx — abort");
    process.exit(1);
  }
  const workerUp = sh("pgrep -f '[w]orkers/index.ts' | head -1").length > 0;
  if (!workerUp) {
    console.error("FATAL: worker 未 running — abort");
    process.exit(1);
  }
  const mediaKey = process.env.MEDIA_ENC_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(mediaKey)) {
    console.error("FATAL: MEDIA_ENC_KEY 未設/格式唔啱（.env）— abort（DLQ 加密必需）");
    process.exit(1);
  }
  const ctl = pgCtl();
  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  if (!clinic?.waPhoneNumberId || !clinic?.waDisplayNumber) {
    console.error("FATAL: clinic TKW 冇 waPhoneNumberId/waDisplayNumber — abort");
    process.exit(1);
  }
  const bizNumber = clinic.waDisplayNumber.replace(/\D/g, "");
  console.log("  (前置 OK：PG 3100 worker MEDIA_ENC_KEY clinic)");

  const dlqBefore = await prisma.deadLetter.count({ where: { queue: "inbound" } });
  const ts = Date.now();
  const run = `T610${ts}`;
  const A = [`${run}-a1`, `${run}-a2`, `${run}-a3`];
  const B = [`${run}-b1`, `${run}-b2`, `${run}-b3`];
  const fromA = `8526${(ts % 100000000).toString().padStart(8, "0").slice(0, 8)}`;
  const fromB = `8527${(ts % 100000000).toString().padStart(8, "0").slice(0, 8)}`;

  const stopLog = path.join("/tmp", `e2e-t610-pg-${ts}.log`);

// ★ T610 專用：DB 死時段 mock-inbound 唔可用（佢自己 prisma 查 clinic 會炸）— 直接 signed fetch。
//   signature 同 mock-inbound 同一口徑：sha256=HMAC-SHA256(WA_APP_SECRET, rawBody)。
const WEBHOOK_URL = "http://127.0.0.1:3100/api/wa/webhook";
function buildPayload(phoneId: string, bizNumber: string, wamid: string, from: string, text: string): string {
  const now = Math.floor(Date.now() / 1000).toString();
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: phoneId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: bizNumber, phone_number_id: phoneId },
              contacts: [],
              messages: [{ from, id: wamid, timestamp: now, type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
  return JSON.stringify(payload);
}
async function sendInbound(phoneId: string, bizNumber: string, wamid: string, from: string, text: string): Promise<void> {
  const raw = buildPayload(phoneId, bizNumber, wamid, from, text);
  const signature = "sha256=" + createHmac("sha256", process.env.WA_APP_SECRET ?? "").update(raw).digest("hex");
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`webhook POST ${res.status} (${wamid}): ${body}`);
  }
  await res.text().catch(() => undefined);
}
  const stopPg = async (label: string): Promise<void> => {
    execSync(`${ctl} -D ${PGDATA} stop -m fast`, { stdio: "pipe", timeout: 60_000 });
    const t0 = Date.now();
    while (pgReady() && Date.now() - t0 < 30_000) await sleep(500);
    check(`${label}: PG 已 stop`, !pgReady());
  };
  const startPg = async (label: string): Promise<void> => {
    execSync(`${ctl} -D ${PGDATA} start -m fast -w -o "-p ${PG_PORT}" -l ${stopLog}`, { stdio: "pipe", timeout: 60_000 });
    const t0 = Date.now();
    while (!pgReady() && Date.now() - t0 < 30_000) await sleep(500);
    check(`${label}: PG 已還原`, pgReady());
  };

  let pgRestored = false;
  try {
    // ── Case A：stop 20s → retry 成功，無 DLQ ──────────────────────────
    console.log("\n[Case A] 短暫 stop（~20s）— retry 應該救返");
    await stopPg("A");
    for (const w of A) await sendInbound(clinic.waPhoneNumberId, bizNumber, w, fromA, "book a follow-up please");
    console.log(`  (A：3 條 webhook 已入 queue @ stop 時段)`);
    await sleep(20_000);
    await startPg("A");
    const nA = await waitMessages(A, 180_000);
    check("A: 3 條訊息全部入 DB", nA === 3, { nA });
    const dlqA = await prisma.deadLetter.count({ where: { queue: "inbound" } });
    check("A: DLQ 零新增（未達最終失敗）", dlqA === dlqBefore, { dlqA, dlqBefore });

    // ── Case B：stop ~6 分鐘 → 最終失敗 → DLQ → replay → 入 DB 無重複 ──
    console.log("\n[Case B] stop ~6 分鐘 — 最終失敗 → DLQ → replay");
    await stopPg("B");
    for (const w of B) await sendInbound(clinic.waPhoneNumberId, bizNumber, w, fromB, "book a follow-up please");
    console.log("  (B：3 條 webhook 已入 queue；等待最終失敗 ~4.2 分鐘 + DLQ write 跨 PG 重啟)");
    await sleep(6 * 60_000);
    await startPg("B");
    pgRestored = true;

    const dlqB = await waitDlq(dlqBefore + 3, 300_000);
    check("B: DLQ 恰 3 條新增", dlqB === dlqBefore + 3, { dlqB, dlqBefore });

    const alertOpen = await prisma.alert.count({ where: { type: "inbound_failed", resolvedAt: null } });
    check("B: inbound_failed alert 恰 1 條未解決（冪等）", alertOpen === 1, { alertOpen });

    // replay CLI（實測 artifact；worker 跑緊 → 重入隊後會處理）
    const replay = spawnSync("pnpm", ["-s", "tsx", "scripts/replay-dead-letters.ts"], { cwd: ROOT, stdio: "pipe", timeout: 120_000 });
    const replayOut = `${replay.stdout?.toString() ?? ""}${replay.stderr?.toString() ?? ""}`.trim().split("\n").pop() ?? "";
    console.log(`  (replay CLI: ${replayOut})`);
    check("B: replay CLI 成功 3/3", replay.status === 0 && /3\/3/.test(replayOut), { status: replay.status, out: replayOut.slice(-200) });

    const nB = await waitMessages(B, 180_000);
    check("B: replay 後 3 條訊息入 DB", nB === 3, { nB });
    const dup = await prisma.message.findMany({ where: { waMessageId: { in: B } }, select: { waMessageId: true } });
    check("B: 無重複訊息（claim 冪等）", dup.length === 3, { rows: dup.length });
    const replayed = await prisma.deadLetter.count({ where: { queue: "inbound", replayedAt: null } });
    check("B: DLQ 全部標 replayedAt", replayed === 0, { replayed });
  } finally {
    // 鐵律：任何情況都還原 PG（stop 咗先會需要）
    if (!pgRestored && !pgReady()) {
      try {
        await startPg("finally");
      } catch (e) {
        console.error(`FATAL: PG 還原失敗 — 人手處理：${ctl} -D ${PGDATA} start -m fast -w -o "-p ${PG_PORT}"`, e);
      }
    }
  }

  // ── 清理：resolve test alert（訊息留低 — dev 數據，wamid 唯一唔撞其他 test） ──
  await prisma.alert.updateMany({ where: { type: "inbound_failed", resolvedAt: null }, data: { resolvedAt: new Date() } });
  console.log("\n  (cleanup: inbound_failed alert 已 resolve；test 訊息留低 dev DB)");

  if (failures > 0) {
    console.log(`T610 FAIL: ${failures} 項`);
    process.exit(1);
  }
  console.log("T610-OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("T610 error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
