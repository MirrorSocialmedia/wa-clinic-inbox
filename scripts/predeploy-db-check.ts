import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";

// ★ cwi-final S0-10：predeploy DB 檢查 — 任何 fail → exit 1
// （tsx CJS transform 唔食 top-level await — 包 async IIFE，spec 語義逐字）
const main = async () => {
  const prisma = new PrismaClient();
  let fail = false;
  // ① 未 apply 嘅 migration
  try {
    const out = execSync("pnpm -s prisma migrate status", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    console.log(/Database schema is up to date/.test(out) ? "  ✓ migrations up to date" : "  ⚠ migrations 有未 apply（deploy 會跑 migrate deploy）");
  } catch (e) {
    console.log("  ⚠ migrations 有未 apply 或者狀態讀唔到：", String((e as { stdout?: string }).stdout ?? e).split("\n").slice(-4).join(" | "));
  }
  // ② R-2：任何 legacy aiMode=AUTO 店 → 停（automation.ts:78 會當 L2）
  const auto = await prisma.clinic.findMany({ where: { aiMode: "AUTO" }, select: { code: true } });
  if (auto.length) { console.log(`  ✗ aiMode=AUTO：${auto.map((c) => c.code).join(",")} — 先轉做明確 AutomationPolicy`); fail = true; }
  else console.log("  ✓ 冇 aiMode=AUTO 店");
  // ③ S0-12：未開 G2 但有 HELD hold（理論上 0）
  if (process.env.ALLOW_SLOT_CLAIM !== "1") {
    const held = await prisma.flowHoldEvent.count({ where: { status: "HELD" } });
    console.log(held ? `  ⚠ 有 ${held} 張 HELD hold（G2 未開）— 人手核對` : "  ✓ 冇 HELD hold");
  }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
};

main().catch((e) => {
  console.error("predeploy-db-check 失敗：", e);
  process.exit(1);
});
