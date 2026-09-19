/**
 * ★ cwi-final S1-1b — T713：notify 失敗 containment + skipped 分支補做副作用。
 *
 * Phase 1（try/catch containment）：touch .dev/notify-chaos-fail → mock inbound text →
 *   notifyNewMessage throw 一次（dev chaos hook）→ 斷言：訊息入 DB + AiDraft 有建（flow 繼續咗）
 *   + DLQ 零新增（job 冇 fail）。
 * Phase 2（skipped 分支補做）：
 *   a. 刪 msgA 嘅 AiDraft + Redis ai job key → 重發同 wamid webhook → skipped 分支補做 → draft 重現。
 *   b. msgB（media image）wait SKIPPED → 手改 PENDING + 刪 Redis media job key（模擬 commit 後 crash）
 *      → 重發同 wamid → skipped 分支補做 media → 再 SKIPPED（誠實終態；mock mode 下載唔到）。
 *   斷言：無重複訊息（claim 冪等）。
 *
 * 跑法：pnpm tsx scripts/e2e-t713-side-effects.ts（dev 3100 + worker 要跑緊；唔停 DB）
 * 收結：process.exit(0/1)。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import prisma from "../src/lib/prisma";
import { getRedis } from "../src/lib/queue";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAOS_FILE = path.join(ROOT, ".dev/notify-chaos-fail");
const ts = Date.now();
const WAMID_A = `T713${ts}a`;
const WAMID_B = `T713${ts}b`;
const FROM_A = `8526${(ts % 100000000).toString().padStart(8, "0").slice(0, 8)}`;
const FROM_B = `8527${(ts % 100000000).toString().padStart(8, "0").slice(0, 8)}`;

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown): void {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${ok ? "" : ` ${JSON.stringify(extra ?? null)}`}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sendInbound(wamid: string, from: string, text: string, media?: string): void {
  const args = ["-s", "mock-inbound", "message", "--clinic", "TKW", "--from", from, "--text", text, "--wamid", wamid];
  if (media) args.push("--media", media);
  const r = spawnSync("pnpm", args, { cwd: ROOT, stdio: "pipe", timeout: 60_000 });
  const out = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`;
  if (r.status !== 0) throw new Error(`mock-inbound 失敗 (${wamid}): ${out.slice(-300)}`);
}

async function waitMsg(wamid: string, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    const m = await prisma.message.findUnique({ where: { waMessageId: wamid } });
    if (m) return m;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(3000);
  }
}
async function waitDraft(messageId: string, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    const d = await prisma.aiDraft.findFirst({ where: { inReplyToMessageId: messageId }, select: { id: true } });
    if (d) return d;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(3000);
  }
}
async function waitMediaStatus(messageId: string, status: string, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const m = await prisma.message.findUnique({ where: { id: messageId }, select: { mediaStatus: true } });
    if (m?.mediaStatus === status) return true;
    if (Date.now() - t0 > timeoutMs) return m?.mediaStatus === status;
    await sleep(3000);
  }
}

async function main(): Promise<void> {
  console.log("[T713] notify 失敗 containment + skipped 分支補做");
  mkdirSync(path.dirname(CHAOS_FILE), { recursive: true });

  const dlqBefore = await prisma.deadLetter.count({ where: { queue: "inbound" } });
  const redis = getRedis();

  try {
    // ── Phase 1：notify throw 一次 → 唔 fail job ──────────────────────────
    console.log("\n[Phase 1] chaos hook 觸發 notifyNewMessage throw（一次）");
    writeFileSync(CHAOS_FILE, "t713");
    sendInbound(WAMID_A, FROM_A, "book a follow-up please");
    const msgA = await waitMsg(WAMID_A, 120_000);
    check("P1a: 訊息入 DB", Boolean(msgA), { wamid: WAMID_A });
    if (msgA) {
      const draftA = await waitDraft(msgA.id, 120_000);
      check("P1b: AiDraft 有建（flow 喺 catch 後繼續咗 — aiQueue.add 喺 notify 之後）", Boolean(draftA), { messageId: msgA.id });
    }
    await sleep(3000);
    const dlqAfter = await prisma.deadLetter.count({ where: { queue: "inbound" } });
    check("P1c: DLQ 零新增（job 冇 fail — catch containment）", dlqAfter === dlqBefore, { dlqAfter, dlqBefore });

    // ── Phase 2a：skipped 分支補做 AI ───────────────────────────────────
    console.log("\n[Phase 2a] 刪 draft + ai job → 重發同 wamid → skipped 分支補做");
    if (msgA) {
      await prisma.aiDraft.deleteMany({ where: { inReplyToMessageId: msgA.id } });
      await redis.del(`wa-inbox:ai:ai-${msgA.id}`);
      const gone = await redis.exists(`wa-inbox:ai:ai-${msgA.id}`);
      check("P2a-0: ai job key 已清", gone === 0, { exists: gone });
      sendInbound(WAMID_A, FROM_A, "book a follow-up please");
      const draftA2 = await waitDraft(msgA.id, 120_000);
      check("P2a: 重發後 AiDraft 重現（skipped 分支補做）", Boolean(draftA2), { messageId: msgA.id });
      const cntA = await prisma.message.count({ where: { waMessageId: WAMID_A } });
      check("P2a-dup: 無重複訊息", cntA === 1, { cntA });
    }

    // ── Phase 2b：skipped 分支補做 media ─────────────────────────────────
    console.log("\n[Phase 2b] media 模擬 commit 後 crash（PENDING + job 清走）→ 重發 → 補做");
    sendInbound(WAMID_B, FROM_B, "photo please", "image");
    const msgB = await waitMsg(WAMID_B, 120_000);
    // 註：mock mode media worker 極快（PENDING → SKIPPED 可能喺 waitMsg 首次 poll 前已完成）—
    // 斷言只核「訊息入 DB」；media 狀態由 P2b-1 負責（waitMediaStatus 由 PENDING 或已 SKIPPED 都收）。
    check("P2b-0: media 訊息入 DB", Boolean(msgB), { wamid: WAMID_B, mediaStatus: msgB?.mediaStatus });
    if (msgB) {
      const skipped1 = await waitMediaStatus(msgB.id, "SKIPPED", 120_000);
      check("P2b-1: 首次處理 mock 下載 → SKIPPED", skipped1);
      // 模擬 crash：留 PENDING + 原 job 清走
      await prisma.message.update({ where: { id: msgB.id }, data: { mediaStatus: "PENDING" } });
      await redis.del(`wa-inbox:media:media-${msgB.id}`);
      sendInbound(WAMID_B, FROM_B, "photo please", "image");
      const skipped2 = await waitMediaStatus(msgB.id, "SKIPPED", 120_000);
      check("P2b-2: 重發後 skipped 分支補做 media → SKIPPED", skipped2);
      const cntB = await prisma.message.count({ where: { waMessageId: WAMID_B } });
      check("P2b-dup: 無重複訊息", cntB === 1, { cntB });
    }
  } finally {
    rmSync(CHAOS_FILE, { force: true });
  }

  if (failures > 0) {
    console.log(`T713 FAIL: ${failures} 項`);
    process.exit(1);
  }
  console.log("T713-OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("T713 error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
