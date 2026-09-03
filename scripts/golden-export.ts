/**
 * ★ Part F（cwi-raggolden-20260904，F.5）：GoldenCase export。
 *
 * 用法：pnpm golden:export [--clinic TKW] [--all]
 *   默認：enabled=true（即「收貨」咗嘅案例）
 *   --all：連 enabled=false（未審核）一齊出（備份/審查用）
 *
 * 輸出：evals/golden/<YYYY-MM-DD>.jsonl — 每行一個 case（零 PII：utterance/contextBefore 入庫時已 deid）。
 * eval runner（scripts/eval-golden.ts）食同一份 JSONL 格式。
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch { /* ok */ }

const args = process.argv.slice(2);
function argVal(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const clinicArg = argVal("--clinic");
const all = args.includes("--all");
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const where = {
    ...(clinicArg ? { clinicId: await (async () => {
      const c = await prisma.clinic.findUnique({ where: { code: clinicArg } });
      if (!c) { console.error(`clinic ${clinicArg} 唔存在`); process.exit(1); }
      return c.id;
    })() } : {}),
    ...(all ? {} : { enabled: true }),
  };
  const cases = await prisma.goldenCase.findMany({
    where,
    orderBy: [{ createdAt: "asc" }],
  });
  const rows = cases.map((c) => ({
    id: c.id,
    clinicId: c.clinicId,
    source: c.source,
    utterance: c.utterance,
    contextBefore: c.contextBefore ?? [],
    expectIntent: c.expectIntent,
    expectRedFlag: c.expectRedFlag,
    expectAutoOk: c.expectAutoOk,
    expectDocIds: c.expectDocIds ?? [],
    enabled: c.enabled,
    note: c.note ?? null,
    createdAt: c.createdAt.toISOString(),
  }));
  const dir = join(process.cwd(), "evals", "golden");
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const out = join(dir, `${date}.jsonl`);
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  console.log(`golden:export → ${out}（${rows.length} cases${all ? "（--all 含未審核）" : "（enabled only）"}）`);
}

main().finally(() => prisma.$disconnect());
