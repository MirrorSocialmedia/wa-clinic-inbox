/**
 * Seed script — 3 間 clinic（TKW/MF/WTC，假 waPhoneNumberId）+ 1 ADMIN + 各 1 STAFF
 * + 醫生名錄（Provider/ProviderClinic — Phase 3 SCREEN_PROVIDER 來源）。
 *
 * 用法：pnpm db:seed（= prisma db seed）
 * 冪等：clinic 按 code upsert、staff 按 email upsert、provider 按 apricotId upsert。
 * 密碼只喺「首次建立」時打 log 一次（iron rule：唔存明文，重跑唔會再顯示）。
 *
 * Phase 3 補充：
 * - 醫生名錄由 greetingConfig.doctors 派生，決定性 apricotId（mock-pract-<clinic>-<n>）—
 *   mock fixture（APRICOT_MOCK=1）同 seed 同一套 id，E2E slot 斷言先可以決定性。
 * - apricotClinicId 用 MOCK_APRICOT_<code>（真 bot 帳號開通後由 admin 改真值）。
 */
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRED_FILE = path.join(__dirname, "../.dev/credentials.txt");

/** 讀舊 credential lines（email → line）— 重跑時保留之前創號嘅密碼行。 */
function readPrevCreds(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const line of readFileSync(CRED_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9 ]+): (\S+) \/ (.+)$/);
      if (m) map.set(m[2], line);
    }
  } catch {
    /* 首次運行冇檔 */
  }
  return map;
}

function writeCreds(lines: string[]): void {
  try {
    mkdirSync(path.dirname(CRED_FILE), { recursive: true });
    writeFileSync(CRED_FILE, `# Local dev credentials (seed output — gitignored)\n${lines.join("\n")}\n`);
  } catch {
    /* 寫唔到檔唔阻 seed（密碼已打 log） */
  }
}

const CLINICS = [
  {
    code: "TKW",
    name: "TKW 診所（試點店）",
    waPhoneNumberId: "109990000000001",
    waDisplayNumber: "+852 3001 0001",
    apricotClinicId: "MOCK_APRICOT_TKW",
    greetingConfig: {
      address: "香港旺角彌敦道 100 號 TKW 大廈 3 樓",
      openingHours: "一、二、四、五 10:00-19:00；三、六 10:00-14:00；日公假",
      doctors: ["陳明軒（主理）", "李婉如", "王嘉豪"],
      faq: [
        { q: "邊度停車？", a: "大廈地下有 2 小時免費停車位，出示小票可以延期 1 小時。" },
        { q: "接受唔接受保險？", a: "接受 AIA / FWD / CP 醫療保險，請帶保單副本。" },
      ],
    },
  },
  {
    code: "MF",
    name: "MF 診所",
    waPhoneNumberId: "109990000000002",
    waDisplayNumber: "+852 3001 0002",
    apricotClinicId: "MOCK_APRICOT_MF",
    greetingConfig: {
      address: "香港灣仔軒尼詩道 200 號 MF 中心 5 樓",
      openingHours: "一至五 09:30-18:30；六 09:30-13:00；日公假",
      doctors: ["張家俊", "黃詩韻"],
      faq: [],
    },
  },
  // Phase 3：第三間試點店（mock fixture 要求 3 店 × 醫生 × 未來 7 日 slot）
  {
    code: "WTC",
    name: "WTC 診所（第三試點店）",
    waPhoneNumberId: "109990000000003",
    waDisplayNumber: "+852 3001 0003",
    apricotClinicId: "MOCK_APRICOT_WTC",
    greetingConfig: {
      address: "香港中環德輔道中 300 號 WTC 大廈 8 樓",
      openingHours: "一至六 10:00-18:00；日公假",
      doctors: ["劉嘉欣", "沈浩然"],
      faq: [],
    },
  },
];

const USERS = [
  { email: "admin@wa-clinic.local", name: "指揮大神", role: "ADMIN" as const, clinicCode: null },
  { email: "staff-tkw@wa-clinic.local", name: "TKW 前台", role: "STAFF" as const, clinicCode: "TKW" },
  { email: "staff-mf@wa-clinic.local", name: "MF 前台", role: "STAFF" as const, clinicCode: "MF" },
  { email: "staff-wtc@wa-clinic.local", name: "WTC 前台", role: "STAFF" as const, clinicCode: "WTC" },
];

function randomPassword(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("base64url")}`;
}

async function main(): Promise<void> {
  const clinicIds = new Map<string, string>();
  const prevCreds = readPrevCreds();

  for (const c of CLINICS) {
    const clinic = await prisma.clinic.upsert({
      where: { code: c.code },
      update: {
        name: c.name,
        waPhoneNumberId: c.waPhoneNumberId,
        waDisplayNumber: c.waDisplayNumber,
        apricotClinicId: c.apricotClinicId,
        greetingConfig: c.greetingConfig as object,
      },
      create: c,
    });
    clinicIds.set(c.code, clinic.id);
    console.log(`[seed] clinic ${c.code} (${clinic.id}) waPhoneNumberId=${c.waPhoneNumberId} apricotClinicId=${c.apricotClinicId}`);
  }

  // Phase 3：醫生名錄（Provider/ProviderClinic）— 決定性 apricotId（mock fixture 對照用）
  for (const c of CLINICS) {
    const clinicId = clinicIds.get(c.code)!;
    const doctors: string[] = (c.greetingConfig.doctors as string[]) ?? [];
    for (let i = 0; i < doctors.length; i++) {
      const apricotId = `mock-pract-${c.code.toLowerCase()}-${i + 1}`;
      const name = doctors[i];
      const provider = await prisma.provider.upsert({
        where: { apricotId },
        update: { name, active: true },
        create: { name, apricotId, active: true },
      });
      await prisma.providerClinic.upsert({
        where: { providerId_clinicId: { providerId: provider.id, clinicId } },
        update: {},
        create: { providerId: provider.id, clinicId },
      });
    }
    console.log(`[seed] ${c.code} doctors: ${doctors.join(", ")}`);
  }

  const credLines: string[] = [];

  for (const u of USERS) {
    const existing = await prisma.staffUser.findUnique({ where: { email: u.email } });
    const clinicId = u.clinicCode ? clinicIds.get(u.clinicCode) ?? null : null;

    if (existing) {
      // 重跑：只確保 clinicId 正確（密碼唔再顯示 — 冇明文記錄，唔會洩漏）
      const needsUpdate = existing.clinicId !== clinicId || existing.active === false;
      if (needsUpdate) {
        await prisma.staffUser.update({
          where: { id: existing.id },
          data: { clinicId, active: true },
        });
      }
      console.log(`[seed] user ${u.email} exists — skipped (password NOT re-shown)`);
      continue;
    }

    const password = randomPassword(u.role === "ADMIN" ? "Admin" : "Staff");
    const passwordHash = await argon2.hash(password);
    const user = await prisma.staffUser.create({
      data: {
        email: u.email,
        passwordHash,
        name: u.name,
        role: u.role,
        clinicId,
        active: true,
      },
    });
    const label = u.role === "ADMIN" ? "ADMIN" : `${u.clinicCode} STAFF`;
    credLines.push(`${label}: ${user.email} / ${password}`);
    console.log(`[seed] created ${u.role} ${user.email}  password=${password}  (only shown ONCE; saved to .dev/credentials.txt)`);
  }

  // credentials 檔：舊行（existing 用戶）+ 今次新建行 — 一次寫定（冪等）
  const ordered: string[] = [];
  for (const u of USERS) {
    if (credLines.some((l) => l.includes(u.email))) {
      ordered.push(credLines.find((l) => l.includes(u.email))!);
    } else {
      const prev = prevCreds.get(u.email);
      if (prev) ordered.push(prev);
    }
  }
  if (ordered.length > 0) writeCreds(ordered);

  console.log("[seed] done");
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
