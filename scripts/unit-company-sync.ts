/**
 * unit-company-sync — cwi-followup-p0-20260915（S5）：公司同步邏輯 unit tests
 *
 * 範圍（MD §1.1）：
 *   T1 CompaniesResponse zod 契約 — mock fetchCompanies() 過 schema（形狀釘住）
 *   T2 name-match（data migration）— 本地 A/B/C 按 name 對 workforce → sourceId 填
 *   T3 未配對 — 造一間 name 對唔上嘅 temp 公司 → sync 後 sourceId 留 null + 入 unmatchedLocal
 *   T4 冪等 — 第二輪 sync 零變動（nameMatched/created/clinicsMapped = 0）
 *   T5 Clinic.companyId — mock 每間店 code 對返 W clinic 嘅 companyId
 *
 * 跑喺 dev DB（15432）+ WORKFORCE_MOCK=1（決定性 mock，sourceId 同 CWM dev seed 一樣）。
 * 用法（repo root）：pnpm tsx scripts/unit-company-sync.ts
 * 退出碼：0 = 全過；1 = 有 fail。
 */

const envPath = new URL("../.env", import.meta.url).pathname;
try {
  process.loadEnvFile(envPath);
} catch {
  /* 靠 process env */
}
process.env.WORKFORCE_MOCK = "1"; // 決定性 — 唔依賴 .env 現值

import { fetchCompanies, CompaniesResponse } from "../src/lib/workforce/client";
import { syncCompaniesFromWorkforce } from "../src/lib/company-sync";
import prisma from "../src/lib/prisma";

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

const TEMP_ID = "unitfup0tempco0000000001"; // 25 lowercase alnum（cuid 形）

async function main(): Promise<void> {
  // ── T1 zod 契約 ────────────────────────────────────────────────────
  const remote = await fetchCompanies();
  const parsed = CompaniesResponse.safeParse(remote);
  check("T1 mock fetchCompanies 過 zod 契約", parsed.success, JSON.stringify(parsed.error?.issues));
  check("T1 remote 3 間公司（菁薈/臻善/匯樂）", remote.companies.length === 3, `got ${remote.companies.length}`);

  // ── 重跑安全：reset A/B/C sourceId（本 ticket 擁有呢份狀態）+ 清理舊 temp ──
  await prisma.company.updateMany({ where: { code: { in: ["A", "B", "C"] } }, data: { sourceId: null } });
  await prisma.company.deleteMany({ where: { id: TEMP_ID } });

  // ── T2 name-match（data migration）────────────────────────────────
  const r1 = await syncCompaniesFromWorkforce();
  check("T1 sync #1 ok", r1.ok, r1.ok ? "" : r1.error);
  if (!r1.ok) return finish();
  check("T2 sync #1 nameMatched=3（A/B/C 全對上）", r1.summary.nameMatched === 3, `got ${r1.summary.nameMatched}`);
  check("T2 sync #1 created=0（dev 公司全 name 對上 — 唔造新）", r1.summary.companiesCreated === 0, `got ${r1.summary.companiesCreated}`);

  const a = await prisma.company.findUnique({ where: { code: "A" } });
  const b = await prisma.company.findUnique({ where: { code: "B" } });
  const c = await prisma.company.findUnique({ where: { code: "C" } });
  check("T2 A=菁薈 → sourceId=fup0cmpa…", a?.sourceId === "fup0cmpa0000000000000000001", a?.sourceId ?? "null");
  check("T2 B=臻善 → sourceId=fup0cmpb…", b?.sourceId === "fup0cmpb0000000000000000002", b?.sourceId ?? "null");
  check("T2 C=匯樂 → sourceId=fup0cmpc…", c?.sourceId === "fup0cmpc0000000000000000003", c?.sourceId ?? "null");

  // ── T3 未配對（temp 公司 name 對唔上）────────────────────────────
  await prisma.company.create({
    data: { id: TEMP_ID, code: "ZZ", name: "ZZ測試公司（unit temp）", sourceId: null },
  });
  const r2 = await syncCompaniesFromWorkforce();
  check("T3 sync #2 ok", r2.ok, r2.ok ? "" : r2.error);
  if (r2.ok) {
    const un = r2.summary.unmatchedLocal.map((u) => u.id);
    check("T3 temp 公司 sourceId 留 null + 入 unmatchedLocal", un.includes(TEMP_ID), JSON.stringify(un));
    check("T3 temp 公司唔會被 name-match（name 對唔上）", (await prisma.company.findUnique({ where: { id: TEMP_ID } }))?.sourceId === null);
  }

  // ── T4 冪等（第三輪零變動）────────────────────────────────────────
  const r3 = await syncCompaniesFromWorkforce();
  check("T4 sync #3 ok", r3.ok, r3.ok ? "" : r3.error);
  if (r3.ok) {
    check("T4 冪等：nameMatched=0 / created=0 / clinicsMapped=0", r3.summary.nameMatched === 0 && r3.summary.companiesCreated === 0 && r3.summary.clinicsMapped === 0, JSON.stringify(r3.summary));
  }

  // ── T5 Clinic.companyId 對應 ──────────────────────────────────────
  // mock 映射：TY→菁薈(A) / YMT,TW,MF→臻善(B) / TKW,YL,WTC→匯樂(C)
  const expected: Record<string, string> = { TY: "A", YMT: "B", TW: "B", MF: "B", TKW: "C", YL: "C", WTC: "C" };
  const compByCode: Record<string, string> = {};
  for (const x of [a, b, c]) if (x) compByCode[x.code] = x.id;
  let t5ok = true;
  let t5detail = "";
  for (const [clinicCode, compCode] of Object.entries(expected)) {
    const cl = await prisma.clinic.findUnique({ where: { code: clinicCode } });
    if (!cl) { t5ok = false; t5detail = `clinic ${clinicCode} 唔存在`; break; }
    if (cl.companyId !== compByCode[compCode]) { t5ok = false; t5detail = `clinic ${clinicCode} → ${cl.companyId} 唔係公司 ${compCode} (${compByCode[compCode]})`; break; }
  }
  check("T5 7 間 clinic 嘅 companyId 同 workforce 映射一致", t5ok, t5detail);

  // ── cleanup ───────────────────────────────────────────────────────
  await prisma.company.deleteMany({ where: { id: TEMP_ID } });
  const leftover = await prisma.company.findUnique({ where: { id: TEMP_ID } });
  check("cleanup temp 公司洗走", leftover === null);

  // 註：CompanySyncRun 行由 caller（cron worker / admin API）落 — 本 unit 直調 sync fn 唔落行；S7 e2e 覆蓋。
}

function finish(): void {
  console.log(`\n[unit-company-sync] ${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main()
  .then(() => finish())
  .catch((e) => {
    console.error("[unit-company-sync] FATAL", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
