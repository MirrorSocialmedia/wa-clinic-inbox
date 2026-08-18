/**
 * Seed script — 2 間 clinic（TKW/MF，假 waPhoneNumberId）+ 1 ADMIN + 各 1 STAFF。
 *
 * 用法：pnpm db:seed（= prisma db seed）
 * 冪等：clinic 按 code upsert、staff 按 email upsert。
 * 密碼只喺「首次建立」時打 log 一次（iron rule：唔存明文，重跑唔會再顯示）。
 */
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRED_FILE = path.join(__dirname, "../.dev/credentials.txt");

function writeCredLine(label: string, email: string, password: string): void {
  try {
    mkdirSync(path.dirname(CRED_FILE), { recursive: true });
    writeFileSync(CRED_FILE, `# Local dev credentials (seed output — gitignored)\n${label}: ${email} / ${password}\n`);
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
    greetingConfig: {
      address: "香港灣仔軒尼詩道 200 號 MF 中心 5 樓",
      openingHours: "一至五 09:30-18:30；六 09:30-13:00；日公假",
      doctors: ["張家俊", "黃詩韻"],
      faq: [],
    },
  },
];

const USERS = [
  { email: "admin@wa-clinic.local", name: "指揮大神", role: "ADMIN" as const, clinicCode: null },
  { email: "staff-tkw@wa-clinic.local", name: "TKW 前台", role: "STAFF" as const, clinicCode: "TKW" },
  { email: "staff-mf@wa-clinic.local", name: "MF 前台", role: "STAFF" as const, clinicCode: "MF" },
];

function randomPassword(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("base64url")}`;
}

async function main(): Promise<void> {
  const clinicIds = new Map<string, string>();

  for (const c of CLINICS) {
    const clinic = await prisma.clinic.upsert({
      where: { code: c.code },
      update: {
        name: c.name,
        waPhoneNumberId: c.waPhoneNumberId,
        waDisplayNumber: c.waDisplayNumber,
        greetingConfig: c.greetingConfig as object,
      },
      create: c,
    });
    clinicIds.set(c.code, clinic.id);
    console.log(`[seed] clinic ${c.code} (${clinic.id}) waPhoneNumberId=${c.waPhoneNumberId}`);
  }

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
    // ★ 密碼只打 log 一次（創號嗰陣）+ 寫入 gitignored .dev/credentials.txt（本地 E2E 用）
    writeCredLine(u.role === "ADMIN" ? "ADMIN" : `${u.clinicCode} STAFF`, user.email, password);
    console.log(`[seed] created ${u.role} ${user.email}  password=${password}  (only shown ONCE; saved to .dev/credentials.txt)`);
  }

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
