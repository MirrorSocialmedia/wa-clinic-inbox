/**
 * ★ cwi-ux UX-07（CI）：src 底下 *.test.ts 跨分店 fixture — 只由 scripts/ci-src-tests.sh 喺獨立 DB wa_t 調用。
 *
 * 點解要：`db:seed` 只建 TKW／MF／WTC，亦唔設 companyId（hub-a migration 嘅 companyId 回填喺 seed 之前跑 →
 * fresh DB 一行都冇 UPDATE 到）。UX-07 測試（bookings/manual、flows、search）要 YL（同公司跨店）同 TY（跨公司）
 * → 開發機 DB 有齊（由生產式資料嚟），CI fresh DB 冇 → before() 拋「seed 要有 TKW/YL/TY 三間店」
 * （CI run 36864659090）。
 *
 * 做法：補建 YL／TY（mock 號碼，唔撞 seed）+ companyId 跟 migration 20260914230000_cwi_hub_a_company Step 2
 * 一模一樣嘅對應（A=TY；B=YMT/TW/MF；C=TKW/YL/WTC）。冪等（upsert；重跑唔變）。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const COMPANY = {
  A: "chubacompanya000000000000001",
  B: "chubacompanyb000000000000002",
  C: "chubacompanyc000000000000003",
} as const;

const EXTRA_CLINICS = [
  { code: "YL", name: "YL 診所（測試）", waPhoneNumberId: "109990000000701", waDisplayNumber: "+852 3001 0701", apricotClinicId: "MOCK_APRICOT_YL", companyId: COMPANY.C },
  { code: "TY", name: "TY 診所（測試）", waPhoneNumberId: "109990000000702", waDisplayNumber: "+852 3001 0702", apricotClinicId: "MOCK_APRICOT_TY", companyId: COMPANY.A },
];

const COMPANY_OF: Record<string, string> = {
  TY: COMPANY.A,
  YMT: COMPANY.B,
  TW: COMPANY.B,
  MF: COMPANY.B,
  TKW: COMPANY.C,
  YL: COMPANY.C,
  WTC: COMPANY.C,
};

async function main() {
  for (const [code, id] of Object.entries({ A: COMPANY.A, B: COMPANY.B, C: COMPANY.C })) {
    await prisma.company.upsert({ where: { id }, update: {}, create: { id, code, name: `Company ${code}`, enabled: true } });
  }
  for (const c of EXTRA_CLINICS) {
    await prisma.clinic.upsert({ where: { code: c.code }, update: {}, create: c });
  }
  for (const [code, companyId] of Object.entries(COMPANY_OF)) {
    await prisma.clinic.updateMany({ where: { code }, data: { companyId } });
  }
  const rows = await prisma.clinic.findMany({ select: { code: true, companyId: true }, orderBy: { code: "asc" } });
  console.log(`seed-src-test-clinics: ${rows.map((r) => `${r.code}=${r.companyId?.slice(-1) ?? "null"}`).join(" ")}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
