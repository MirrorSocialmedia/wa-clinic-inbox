/**
 * s6-mediakey-dupcheck — cwi-final S6-3② mediaKey unique 建前重複檢查。
 *
 * 用法：npx tsx scripts/s6-mediakey-dupcheck.ts [pre|post]
 *   pre  = migration 前：檢查 1-3（任何 >0 = STOP 報 CEO，禁自行刪數據）
 *   post = backfill 後：檢查 1-5（全部必須 = 0）
 *
 * 輸出：每行 "CHECK-N <name>: <count>"（+ 有重複時回前列几行樣本，metadata only — 路徑無 PII）。
 * exit 0 = 全 0；exit 1 = 有重複。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env 冇就靠 process env */
}

import { PrismaClient } from "@prisma/client";

const mode = process.argv[2] ?? "pre";
const prisma = new PrismaClient();

let failures = 0;
async function check(n: number, name: string, sql: string, sampleSql?: string): Promise<void> {
  const rows = (await prisma.$queryRawUnsafe<{ c: string }[]>(sql)) as { c: string }[];
  const c = Number(rows[0]?.c ?? 0);
  console.log(`CHECK-${n} ${name}: ${c}`);
  if (c > 0) {
    failures += 1;
    if (sampleSql) {
      const s = (await prisma.$queryRawUnsafe(sampleSql)) as unknown;
      console.log(`  sample: ${JSON.stringify(s).slice(0, 400)}`);
    }
  }
}

async function main(): Promise<void> {
  // 1. mediaPath 全路徑重複（同一檔對應多條 Message）
  await check(
    1,
    "mediaPath duplicates",
    `SELECT count(*)::text c FROM (SELECT "mediaPath", count(*) FROM "Message" WHERE "mediaPath" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) t`
  );
  // 2. mediaKey（basename）重複（unique index 會撞）
  await check(
    2,
    "mediaKey(basename) duplicates",
    `SELECT count(*)::text c FROM (SELECT regexp_replace("mediaPath", '^.*/', '') AS k, count(*) FROM "Message" WHERE "mediaPath" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) t`,
    `SELECT regexp_replace("mediaPath", '^.*/', '') AS k, count(*) FROM "Message" WHERE "mediaPath" IS NOT NULL GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 5`
  );
  // 3. basename 跨店撞（同 key 出現喺多於 1 個 clinic — 即使每店只有一條，global unique 都會撞）
  await check(
    3,
    "mediaKey(basename) cross-clinic collisions",
    `SELECT count(*)::text c FROM (
       SELECT regexp_replace(m."mediaPath", '^.*/', '') AS k, count(DISTINCT cv."clinicId") AS n
       FROM "Message" m JOIN "Conversation" cv ON cv.id = m."conversationId"
       WHERE m."mediaPath" IS NOT NULL
       GROUP BY 1 HAVING count(DISTINCT cv."clinicId") > 1
     ) t`,
    `SELECT regexp_replace(m."mediaPath", '^.*/', '') AS k, count(DISTINCT cv."clinicId") AS n
       FROM "Message" m JOIN "Conversation" cv ON cv.id = m."conversationId"
       WHERE m."mediaPath" IS NOT NULL GROUP BY 1 HAVING count(DISTINCT cv."clinicId") > 1 LIMIT 5`
  );
  if (mode === "post") {
    // 4. backfill 完整性：mediaPath 有值但 mediaKey 無值
    await check(
      4,
      "mediaPath set but mediaKey null (backfill gap)",
      `SELECT count(*)::text c FROM "Message" WHERE "mediaPath" IS NOT NULL AND "mediaKey" IS NULL`
    );
    // 5. mediaKey 同 mediaPath basename 不一致
    await check(
      5,
      "mediaKey <> basename(mediaPath) mismatch",
      `SELECT count(*)::text c FROM "Message" WHERE "mediaPath" IS NOT NULL AND "mediaKey" IS NOT NULL AND "mediaKey" <> regexp_replace("mediaPath", '^.*/', '')`
    );
  }
}

main()
  .then(() => {
    if (failures > 0) {
      console.log(`DUPCHECK FAIL: ${failures} 項 >0 — ${mode === "pre" ? "STOP 報 CEO（禁刪數據）" : "backfill 有洞"}`);
      process.exitCode = 1;
    } else {
      console.log(`DUPCHECK OK (${mode})`);
    }
  })
  .catch((e) => {
    console.error("DUPCHECK ERROR:", e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
