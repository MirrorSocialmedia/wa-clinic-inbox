/**
 * e2e-query — mock-e2e 嘅 DB 斷言 helper。
 *
 * 用法：pnpm tsx scripts/e2e-query.ts "SELECT count(*) FROM \"Message\""
 * 輸出：rows JSON（console.log）— shell 用 jq / grep 斷言。
 *
 * 只係本地開發/測試用；SQL 由本 repo 嘅 script 傳入（唔係公網入口）。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env 冇就靠 process env */
}

import { PrismaClient } from "@prisma/client";

const sql = process.argv[2];
if (!sql) {
  console.error("usage: e2e-query.ts \"<SQL>\"");
  process.exit(2);
}

const prisma = new PrismaClient();

prisma
  .$queryRawUnsafe(sql)
  .then((rows) => {
    console.log(JSON.stringify(rows));
  })
  .catch((err) => {
    console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
