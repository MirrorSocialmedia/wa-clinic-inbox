/**
 * ★ cwi-final S1-1a — T723：upsertAlert 冪等 + R-28 自動 resolve 邊界。
 *
 * 斷言：
 *  a. upsertAlert({type:"inbound_failed", severity:"HIGH"}) 首調 = true（新開），再調 = false（冪等）
 *  b. runHealthCheck() 兩次 → inbound_failed alert 仍未 resolve（R-28：非 HEALTH_OWNED_TYPES 只准人手 resolve）
 *  c. owned type（backup_failed）breach 消失 → 下一次 health-check 自動 resolve
 *
 * 跑法：pnpm tsx scripts/e2e-t723-upsert-alert.ts（要 dev DB 15432 + Redis；唔停 DB）
 * 收結：process.exit(0/1) — import 鏈開 Redis/Prisma 句柄吊住 event loop，必明確 exit。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import prisma from "../src/lib/prisma";
import { runHealthCheck } from "../src/lib/health/check";
import { upsertAlert } from "../src/lib/health/alerts";

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown): void {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${ok ? "" : ` ${JSON.stringify(extra ?? null)}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log("[T723] upsertAlert 冪等 + R-28 自動 resolve 邊界");

  // ── 0. hermetic 預清（本 test 嘅兩個 type；dev 環境呢啲 type 只由本 test / T610 產生） ──
  const pre = await prisma.alert.deleteMany({ where: { type: { in: ["inbound_failed", "backup_failed"] } } });
  console.log(`  (pre-clean: 刪咗 ${pre.count} 條 inbound_failed/backup_failed)`);

  // ── 1. 模擬一個已有嘅 backup_failed breach alert（owned type，之後 breach 消失） ──
  const backup = await prisma.alert.create({
    data: { type: "backup_failed", severity: "HIGH", clinicId: null, clinicCode: null, detail: { reason: "t723" } },
  });

  // ── 2. inbound_failed alert（R-28：唔喺 HEALTH_OWNED_TYPES） ──
  const first = await upsertAlert({ type: "inbound_failed", severity: "HIGH", detail: { jobId: "t723" } });
  const second = await upsertAlert({ type: "inbound_failed", severity: "HIGH", detail: { jobId: "t723" } });
  check("T723a upsertAlert 首調新開 = true", first === true, { first });
  check("T723b upsertAlert 再調冪等 = false", second === false, { second });

  const openInboundBefore = await prisma.alert.count({ where: { type: "inbound_failed", resolvedAt: null } });
  check("T723c inbound_failed 未解決 alert 恰 1 條", openInboundBefore === 1, { openInboundBefore });

  // ── 3. runHealthCheck ×2 — 控制 dev 變數（queue/breaker/backup 全 override 零 breach） ──
  const overrides = {
    queueDepth: {
      ai: { waiting: 0, failed: 0 },
      outbound: { waiting: 0, failed: 0 },
      inbound: { waiting: 0, failed: 0 },
      media: { waiting: 0, failed: 0 },
    },
    breakerState: "closed" as const,
    backupFlag: { present: false },
  };
  const run1 = await runHealthCheck(overrides);
  const after1 = await prisma.alert.findMany({ where: { type: { in: ["inbound_failed", "backup_failed"] } } });
  const inbound1 = after1.find((a) => a.type === "inbound_failed");
  const backup1 = after1.find((a) => a.type === "backup_failed");
  check("T723d health-check #1 後 backup_failed（owned，breach 消失）自動 resolve", backup1?.resolvedAt !== null, { id: backup1?.id, resolvedAt: backup1?.resolvedAt });
  check("T723e health-check #1 後 inbound_failed 仍未 resolve（R-28）", inbound1?.resolvedAt === null, { id: inbound1?.id, resolvedAt: inbound1?.resolvedAt });

  await runHealthCheck(overrides);
  const inbound2 = await prisma.alert.findFirst({ where: { type: "inbound_failed" } });
  check("T723f health-check #2 後 inbound_failed 仍未 resolve（R-28）", inbound2?.resolvedAt === null, { id: inbound2?.id });

  // ── 4. 清理：test 期間 health-check 新開嘅 alert（dev clinic webhook_stale 等）+ 本 test 兩條 ──
  const createdTypes = new Set(run1.created.map((c) => c.type));
  for (const t of createdTypes) {
    await prisma.alert.updateMany({ where: { type: t, resolvedAt: null }, data: { resolvedAt: new Date() } });
  }
  await prisma.alert.deleteMany({ where: { type: { in: ["inbound_failed", "backup_failed"] } } });
  void backup.id;
  console.log(`  (cleanup: 新開 ${[...createdTypes].join(",") || "無"} 已 resolve；test 兩條已刪)`);

  if (failures > 0) {
    console.log(`T723 FAIL: ${failures} 項`);
    process.exit(1);
  }
  console.log("T723-OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("T723 error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
