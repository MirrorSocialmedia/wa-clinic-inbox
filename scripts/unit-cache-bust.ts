/**
 * unit-cache-bust — Fix B（cwi-fix-20260825-f1）DB-backed unit tests（.env DB — 15432）
 *
 * 範圍（MD B7：applyCacheBust 後 getAutomationLevel / getParams 落 DB）：
 *   G1 automation：seed policy row → 未 bust 返舊值（cache 遮）→ applyCacheBust("automation")
 *      → 即刻返新值（證明落 DB，唔使等 5 分鐘 TTL）
 *   G2 workflow：publish v1 → 繞 store 直改 DB → 未 bust 返舊值 → applyCacheBust("workflow")
 *      → 即刻返新值
 *
 * 隔離：clinicId = `cbust-clinic-<epoch>`（AutomationPolicy 無 FK 約束，任意字串）；
 *       WorkflowDefinition createdBy = `cbust-<epoch>`；finally 清晒。
 *
 * 用法（repo root）：pnpm test:unit-cache-bust
 * 退出碼：0 = 全過；1 = 有 fail
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env 冇就靠 process env */
}

import { prisma } from "../src/lib/prisma";
import { getAutomationLevel, clearAutomationLevelCache } from "../src/lib/ai/automation";
import { getParams, saveDraft, publish, bustParamsCache } from "../src/lib/workflow/store";
import { PARAMS_DEFAULTS } from "../src/lib/workflow/definitions";
import { applyCacheBust } from "../src/lib/cache-bust";

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const EPOCH = Date.now();
const STAFF = `cbust-${EPOCH}`;
const CLINIC = `cbust-clinic-${EPOCH}`;

void (async () => {
  try {
    // ── G1 automation：bust 後落 DB ────────────────────────────────
    console.log("G1 automation cache bust");
    {
      clearAutomationLevelCache(); // 初始乾淨
      const l0 = await getAutomationLevel(CLINIC, "QUESTION");
      check("G1-1 零 policy row → fallback L1（clinic 唔存在 → 保守）", l0 === "L1", l0);

      // seed：QUESTION → L2（clinic 唔存在 → fallback 底 L1；exact row 贏）
      await prisma.automationPolicy.create({ data: { clinicId: CLINIC, category: "QUESTION", level: "L2", updatedBy: STAFF } });

      const l1 = await getAutomationLevel(CLINIC, "QUESTION");
      check("G1-2 未 bust 返舊值 L1（5 分鐘 TTL cache 遮住新 row）", l1 === "L1", l1);

      applyCacheBust("automation");
      const l2 = await getAutomationLevel(CLINIC, "QUESTION");
      check("G1-3 applyCacheBust('automation') 後即刻落 DB → L2", l2 === "L2", l2);
    }

    // ── G2 workflow：bust 後落 DB ──────────────────────────────────
    console.log("G2 workflow cache bust");
    {
      bustParamsCache(); // 初始乾淨
      const d1 = await saveDraft("triage", CLINIC, { ...PARAMS_DEFAULTS.triage, humanCooldownMs: 1111 }, STAFF);
      await publish(d1.id, STAFF);
      bustParamsCache();
      const p1 = await getParams("triage", CLINIC);
      check("G2-1 v1 生效（humanCooldownMs 1111）", p1.humanCooldownMs === 1111, JSON.stringify(p1));

      // 繞 store 直改 DB（模擬另一 process 嘅 write）→ cache 遮
      const activeRow = await prisma.workflowDefinition.findFirst({ where: { key: "triage", clinicId: CLINIC, status: "ACTIVE" } });
      if (!activeRow) {
        check("G2-2 ACTIVE row 存在（前設）", false);
      } else {
        await prisma.workflowDefinition.update({ where: { id: activeRow.id }, data: { params: { ...PARAMS_DEFAULTS.triage, humanCooldownMs: 2222 } } });
        const stale = await getParams("triage", CLINIC);
        check("G2-3 未 bust 返舊值 1111（TTL cache 遮住直改）", stale.humanCooldownMs === 1111, String(stale.humanCooldownMs));

        applyCacheBust("workflow");
        const fresh = await getParams("triage", CLINIC);
        check("G2-4 applyCacheBust('workflow') 後即刻落 DB → 2222", fresh.humanCooldownMs === 2222, String(fresh.humanCooldownMs));
      }
    }
  } finally {
    // 清晒（policy row 按 clinicId；workflow row 按 createdBy marker）
    await prisma.automationPolicy.deleteMany({ where: { clinicId: CLINIC } }).catch(() => null);
    await prisma.workflowDefinition.deleteMany({ where: { createdBy: STAFF } }).catch(() => null);
    clearAutomationLevelCache();
    bustParamsCache();
  }

  console.log(`\nunit-cache-bust: ${passes} pass, ${failures} fail`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
