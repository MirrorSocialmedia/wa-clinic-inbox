try { process.loadEnvFile(new URL("../.env", import.meta.url).pathname); } catch {}
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const rows = await prisma.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) SELECT * FROM "Message" WHERE "mediaKey" = 'e2e-none'`);
  const s = JSON.stringify(rows);
  console.log("Index Scan:", s.includes("Index Scan"), "| unique idx:", s.includes("Message_mediaKey_key"));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
