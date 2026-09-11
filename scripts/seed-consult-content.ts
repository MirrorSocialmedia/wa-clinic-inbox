/**
 * seed-consult-content — ★ consult v2.1 C4（MD §7）：內容 seed（出廠，醫生可改）。
 *
 * 冚家（global clinicId=null — 所有店 inherit；per-clinic 覆寫 = C5 UI 範圍）：
 * - §7.1 箍牙三條 ConsultProduct：TRAD（FIXED）/ IGO + IFULL（CLEAR_ALIGNER）
 *   — displayName/positioning/approvedWording/timeWording/avoidPhrases 照 MD §7.1 表逐字；
 *   priceDocTitle = 「箍牙（矯齒）收費」；**approvedAt = null**（等醫生 UI 確認 — 鐵律：
 *   unapproved 唔准入 prompt/草稿/search）。
 * - §7.2 植牙佔位兩條：HIOSSEN_PENDING / STRAUMANN_PENDING（enabled=false）。
 *
 * 冪等：find-first-by(workflow, code, clinicId=null) → 已存在 skip（唔 clobber 醫生改動）。
 * 用法：pnpm tsx scripts/seed-consult-content.ts [--dry]
 */
import { PrismaClient } from "@prisma/client";
import { seedConsultContent, CONSULT_PRODUCT_SEEDS } from "@/lib/sessions/consult-content";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch { /* .env 冇就靠 process env */ }

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

async function main() {
  if (DRY) {
    console.log(`[dry] 會 seed ${CONSULT_PRODUCT_SEEDS.length} 條 ConsultProduct（global clinicId=null）：`);
    for (const s of CONSULT_PRODUCT_SEEDS) {
      console.log(`  - ${s.workflow} / ${s.code} / ${s.displayName} / enabled=${s.enabled} / approvedAt=null`);
    }
    return;
  }
  const res = await seedConsultContent(prisma);
  console.log(`seed-consult-content: created=${res.created} skipped=${res.skipped} codes=${res.codes.join(",") || "(無)"}`);
  // 驗證：5 條全部存在
  const rows = await prisma.consultProduct.findMany({ where: { clinicId: null, workflow: { in: ["ORTHODONTIC_CONSULT", "IMPLANT_CONSULT"] } }, orderBy: { sortOrder: "asc" } });
  console.log(`現存 global ConsultProduct = ${rows.length} 條：`);
  for (const r of rows) {
    console.log(`  - ${r.workflow} / ${r.code} / enabled=${r.enabled} / approvedAt=${r.approvedAt ? "SET（異常 — 應為 null）" : "null"}`);
  }
}

main()
  .catch((err) => {
    console.error("seed-consult-content failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
