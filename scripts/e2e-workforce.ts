/**
 * e2e-workforce — §3 四層降級鏈 + workforce_api_degraded alert（切換 MD §4 新增 stale/throw 項）
 *
 * 前提：15432 DB + Redis 起緊 + WORKFORCE_MOCK=1（mock flag file 跨 process 切換，唔使真 workforce 站）。
 *
 * 測試項：
 *  1. STALE_SOURCE  — stale flag → getSlots 照回 slots + degraded=STALE_SOURCE + WorkforceSyncState.lastStale=true
 *  2. STALE_CACHE   — fail flag（L2 有過期數據）→ getSlots 回過期 L2 + degraded=STALE_CACHE + lastErrorCode=http_500
 *  3. NONE          — fail flag + 清晒 L2 → getSlots → slots=null + degraded=NONE
 *  4. 恢復          — 清 flag → degraded=null + lastOkAt fresh
 *  5. alert         — 全部 WorkforceSyncState.lastOkAt 倒數 -16 分鐘 → runHealthCheck →
 *                     workforce_api_degraded 未解決 Alert（持續 >15 分鐘邏輯）→ cleanup（resolve + 還原）
 *
 * 用法（repo root）：pnpm e2e:workforce
 * 退出碼：0 = 全過；1 = 有 fail
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
process.env.WORKFORCE_MOCK = "1"; // 本 e2e 恒 mock（flag file 控制 fail/stale）

import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import prisma from "../src/lib/prisma";
import { getSlots, syncWindow } from "../src/lib/availability";
import { runHealthCheck, WORKFORCE_DEGRADED_MIN } from "../src/lib/health/check";

const FAIL_FLAG = path.resolve(".dev/workforce-mock-fail.json");
const STALE_FLAG = path.resolve(".dev/workforce-mock-stale.json");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function writeFlag(p: string, clinicCode: string): void {
  writeFileSync(p, JSON.stringify({ clinicCode }));
}
function rmFlag(p: string): void {
  if (existsSync(p)) unlinkSync(p);
}

async function main(): Promise<void> {
  const clinic = await prisma.clinic.findFirst({ where: { code: "TKW" }, select: { id: true, code: true } });
  if (!clinic) {
    console.error("FAIL: 搵唔到 TKW clinic（seed 先跑）");
    process.exit(1);
  }
  const win = syncWindow();
  console.log(`e2e-workforce: clinic=${clinic.code} window=${win.start}~${win.end} (WORKFORCE_MOCK=1)`);
  try {
    // ── 1. STALE_SOURCE ──────────────────────────────────────────────────
    console.log("[1/5] STALE_SOURCE…");
    await prisma.availabilitySlot.deleteMany({ where: { clinicId: clinic.id } });
    writeFlag(STALE_FLAG, clinic.code);
    let r = await getSlots(clinic.id, win);
    check("degraded=STALE_SOURCE", r.degraded === "STALE_SOURCE", `got=${r.degraded}`);
    check("slots 照回（stale 數據照用）", r.slots !== null && r.slots.length > 0, `slots=${r.slots?.length}`);
    let st = await prisma.workforceSyncState.findUnique({ where: { clinicId: clinic.id } });
    check("WorkforceSyncState.lastStale=true", st?.lastStale === true, JSON.stringify(st));

    // ── 2. STALE_CACHE（L2 有過期數據 + API fail） ────────────────────────
    console.log("[2/5] STALE_CACHE…");
    rmFlag(STALE_FLAG);
    writeFlag(FAIL_FLAG, clinic.code);
    r = await getSlots(clinic.id, win);
    check("degraded=STALE_CACHE", r.degraded === "STALE_CACHE", `got=${r.degraded}`);
    check("過期 L2 照回", r.slots !== null && r.slots.length > 0, `slots=${r.slots?.length}`);
    st = await prisma.workforceSyncState.findUnique({ where: { clinicId: clinic.id } });
    check("lastErrorCode=http_500 + lastErrorAt fresh", st?.lastErrorCode === "http_500" && (st?.lastErrorAt?.getTime() ?? 0) > Date.now() - 60000, JSON.stringify(st));

    // ── 3. NONE（fail + 無 L2） ──────────────────────────────────────────
    console.log("[3/5] NONE…");
    await prisma.availabilitySlot.deleteMany({ where: { clinicId: clinic.id } });
    r = await getSlots(clinic.id, win);
    check("degraded=NONE + slots=null", r.degraded === "NONE" && r.slots === null, `got=${r.degraded} slots=${r.slots === null ? "null" : r.slots.length}`);

    // ── 4. 恢復（清 flag → 正常 fetch） ──────────────────────────────────
    console.log("[4/5] recovery…");
    rmFlag(FAIL_FLAG);
    r = await getSlots(clinic.id, win);
    check("degraded=null（恢復）", r.degraded === null, `got=${r.degraded}`);
    check("L2 重新落庫", r.slots !== null && r.slots.length > 0, `slots=${r.slots?.length}`);
    st = await prisma.workforceSyncState.findUnique({ where: { clinicId: clinic.id } });
    check("lastOkAt fresh（恢復後）", (st?.lastOkAt?.getTime() ?? 0) > Date.now() - 60000, JSON.stringify(st));

    // ── 5. alert（持續 >15 分鐘降級 → workforce_api_degraded） ───────────
    console.log("[5/5] alert…");
    // 清理舊 alert（防假陽性）
    await prisma.alert.updateMany({ where: { type: "workforce_api_degraded", resolvedAt: null }, data: { resolvedAt: new Date() } });
    // 全部 clinic 嘅 lastOkAt 倒數 16 分鐘（health check 用 global max — 要所有店都舊先會 breach）
    const old = new Date(Date.now() - (WORKFORCE_DEGRADED_MIN + 1) * 60000);
    await prisma.workforceSyncState.updateMany({ data: { lastOkAt: old, lastErrorAt: old, lastErrorCode: "http_500" } });
    await runHealthCheck();
    const alert = await prisma.alert.findFirst({ where: { type: "workforce_api_degraded", resolvedAt: null }, select: { id: true, severity: true, detail: true } });
    check("workforce_api_degraded Alert 已開（未解決）", alert !== null, alert ? JSON.stringify(alert.detail) : "no alert");
    check("severity=MEDIUM", alert?.severity === "MEDIUM");

    // cleanup：resolve alert + 還原 state（唔污染下輪 e2e / 真 health check）
    await prisma.alert.updateMany({ where: { type: "workforce_api_degraded", resolvedAt: null }, data: { resolvedAt: new Date() } });
    await prisma.workforceSyncState.updateMany({ data: { lastOkAt: new Date(), lastErrorAt: null, lastErrorCode: null, lastStale: false } });
  } finally {
    rmFlag(FAIL_FLAG);
    rmFlag(STALE_FLAG);
  }

  if (failures === 0) {
    console.log("E2E-WORKFORCE OK");
  } else {
    console.error(`E2E-WORKFORCE FAILED: ${failures} failures`);
    process.exit(1);
  }
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("e2e-workforce error:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
