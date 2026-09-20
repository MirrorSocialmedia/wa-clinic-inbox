// T714 — S1-1c PendingStatus + 單調（4 case，純 API/DB，無 UI）
// 跑法：./node_modules/.bin/tsx scripts/e2e-s11c-t714.ts   （3100 + worker + 15432 需存活）
import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
import { runPendingStatusSweep } from "@/lib/ops/pending-status-sweep";

const prisma = new PrismaClient();
let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function mock(cmd: string): void {
  execSync(`./node_modules/.bin/tsx scripts/mock-inbound.ts ${cmd}`, { timeout: 60000, stdio: "pipe" });
}
async function waitFor(fn: () => Promise<boolean>, ms = 20000, _label = "condition"): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(1000);
  }
  return (await fn());
}

const CLINIC = "TY";
const WA1 = "62019931";
const WA2 = "62019932";
const WA3 = "62019933";
const W1 = `wamid.t714.w1.${Date.now()}`;
const W2 = `wamid.t714.w2.${Date.now()}`;
const W3 = `wamid.t714.w3.${Date.now()}`;
const ORPHAN = `wamid.t714.orphan.${Date.now()}`;

async function convCount(waId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM "Conversation" c JOIN "Contact" ct ON ct.id=c."contactId" WHERE ct."waId"='${waId}'`
  );
  return Number(rows[0].n);
}
function msgStatus(wamid: string): Promise<string | null> {
  return prisma.$queryRawUnsafe<{ status: string }[]>(
    `SELECT status FROM "Message" WHERE "waMessageId"='${wamid}' LIMIT 1`
  ).then((r) => (r.length ? String(r[0].status) : null));
}
function msgErrorCode(wamid: string): Promise<string | null> {
  return prisma.$queryRawUnsafe<{ errorCode: string | null }[]>(
    `SELECT "errorCode" FROM "Message" WHERE "waMessageId"='${wamid}' LIMIT 1`
  ).then((r) => (r.length ? (r[0].errorCode ?? null) : null));
}
async function pendingCount(wamid: string): Promise<number> {
  const r = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT COUNT(*)::int AS n FROM "PendingStatus" WHERE "wamid"='${wamid}'`);
  return Number(r[0].n);
}
async function cleanup(): Promise<void> {
  await prisma.pendingStatus.deleteMany({ where: { wamid: { in: [W1, W2, W3, ORPHAN] } } });
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Message" WHERE "waMessageId" IN ('${W1}','${W2}','${W3}')`
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Conversation" WHERE "contactId" IN (SELECT id FROM "Contact" WHERE "waId" IN ('${WA1}','${WA2}','${WA3}'))`
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" IN ('${WA1}','${WA2}','${WA3}')`);
}

async function main(): Promise<void> {
  await cleanup();

  // ── Case 1：單調 — read 之後到 delivered 唔倒退 ─────────────
  console.log("[1] 單調：read → delivered = READ");
  mock(`message --clinic ${CLINIC} --from ${WA1} --name "T714 C1" --text "c1" --wamid ${W1.replace("wamid.t714.w1.", "wamid.in.")}`);
  ok("C1 conv 建到", (await waitFor(async () => (await convCount(WA1)) > 0, 20000)) === true);
  mock(`echo --clinic ${CLINIC} --to ${WA1} --text "c1 out" --wamid ${W1}`);
  ok("C1 echo OUT 建到（SENT）", (await waitFor(async () => (await msgStatus(W1)) === "SENT", 20000)) === true);
  mock(`status --clinic ${CLINIC} --wamid ${W1} --status read`);
  ok("C1 read 落地", (await waitFor(async () => (await msgStatus(W1)) === "READ", 20000)) === true);
  mock(`status --clinic ${CLINIC} --wamid ${W1} --status delivered`);
  await sleep(3000);
  ok("C1 delivered 唔倒退（終態 READ）", (await msgStatus(W1)) === "READ", `actual=${await msgStatus(W1)}`);

  // ── Case 2：delivered 早過訊息 → park → echo 後 drain ──────
  console.log("[2] delivered 早過訊息 → PendingStatus → echo drain");
  mock(`status --clinic ${CLINIC} --wamid ${W2} --status delivered`);
  ok("C2 parked（PendingStatus=1）", (await waitFor(async () => (await pendingCount(W2)) === 1, 20000)) === true);
  mock(`message --clinic ${CLINIC} --from ${WA2} --name "T714 C2" --text "c2" --wamid ${W2.replace("wamid.t714.w2.", "wamid.in.")}`);
  await waitFor(async () => (await convCount(WA2)) > 0, 20000);
  mock(`echo --clinic ${CLINIC} --to ${WA2} --text "c2 out" --wamid ${W2}`);
  ok("C2 echo 後 status=DELIVERED", (await waitFor(async () => (await msgStatus(W2)) === "DELIVERED", 20000)) === true);
  ok("C2 PendingStatus 清空", (await waitFor(async () => (await pendingCount(W2)) === 0, 15000)) === true);

  // ── Case 3：failed 早到 → drain 後 FAILED + errorCode ───────
  console.log("[3] failed 早到 → FAILED + errorCode");
  mock(`status --clinic ${CLINIC} --wamid ${W3} --status failed`);
  ok("C3 parked（PendingStatus=1）", (await waitFor(async () => (await pendingCount(W3)) === 1, 20000)) === true);
  mock(`message --clinic ${CLINIC} --from ${WA3} --name "T714 C3" --text "c3" --wamid ${W3.replace("wamid.t714.w3.", "wamid.in.")}`);
  await waitFor(async () => (await convCount(WA3)) > 0, 20000);
  mock(`echo --clinic ${CLINIC} --to ${WA3} --text "c3 out" --wamid ${W3}`);
  ok("C3 echo 後 status=FAILED", (await waitFor(async () => (await msgStatus(W3)) === "FAILED", 20000)) === true);
  const ec = await msgErrorCode(W3);
  ok("C3 errorCode 落地", ec !== null, `actual=${ec}`);

  // ── Case 4：sweep — 配對到嘅 drain + 24h 孤兒丟棄 ───────────
  console.log("[4] sweep：配對 drain + 24h 孤兒丟棄");
  const stale = new Date(Date.now() - 25 * 3600_000);
  await prisma.pendingStatus.create({ data: { wamid: ORPHAN, status: "DELIVERED", clinicId: (await prisma.clinic.findFirst({ where: { code: CLINIC } }))!.id, receivedAt: stale } });
  await prisma.pendingStatus.create({ data: { wamid: W1, status: "DELIVERED", clinicId: (await prisma.clinic.findFirst({ where: { code: CLINIC } }))!.id, receivedAt: stale } });
  ok("C4 2 行 stale 插入", (await prisma.pendingStatus.count({ where: { receivedAt: stale } })) === 2);
  console.log("  [debug] sweep 前 PendingStatus 全行:", JSON.stringify(await prisma.$queryRawUnsafe(`SELECT "wamid", status, "receivedAt" FROM "PendingStatus" ORDER BY "wamid"`)));
  const res = await runPendingStatusSweep(Date.now());
  ok("C4 sweep 回傳 drained=1 dropped=1", res.drained === 1 && res.dropped === 1, `actual=${JSON.stringify(res)}`);
  console.log("  [debug] sweep 後 PendingStatus 全行:", JSON.stringify(await prisma.$queryRawUnsafe(`SELECT "wamid", status, "receivedAt" FROM "PendingStatus" ORDER BY "wamid"`)));
  ok("C4 孤兒已丟棄", (await pendingCount(ORPHAN)) === 0);
  ok("C4 配對行已清（W1 保持 READ 唔受 DELIVERED 影響）", (await pendingCount(W1)) === 0 && (await msgStatus(W1)) === "READ", `status=${await msgStatus(W1)}`);

  await cleanup();
  const residual = await prisma.pendingStatus.count({ where: { wamid: { in: [W1, W2, W3, ORPHAN] } } });
  ok("cleanup 零殘留", residual === 0, `residual=${residual}`);
  console.log(`\nT714: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("T714-ERR", e); process.exit(1); }).finally(() => prisma.$disconnect());
