/**
 * e2e-staff — H1 e2e 用嘅臨時 staff 帳戶管理（hermetic：用完即刪）。
 *
 * 用法：
 *   pnpm e2e:staff create --clinic TKW --email staff-e2e-h1@wa-clinic.local --name "E2E H1 Staff B"
 *     → 輸出 STAFF_ID=<id>（冪等：已存在就重用，唔會重複建）
 *   pnpm e2e:staff delete --email staff-e2e-h1@wa-clinic.local
 *     → 刪晒呢個 staff 相關行（Message.sentByStaffId / NoteReadReceipt / AuditLog /
 *        Conversation.assigneeId→null / StaffUser）
 *
 * 密碼：從 gitignored 嘅 .dev/e2e-fixtures.txt 讀取（KEY=VALUE 行：H1_B_EMAIL / H1_B_PASSWORD）—
 *   DEV-ONLY fixture，帳戶每次 e2e 完即刻刪（hermetic），repo 內零密碼字串。
 *   （用獨立檔因為 seed 每 run 會覆寫 .dev/credentials.txt）
 */
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { readFileSync } from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();

/** ★ DEV-ONLY：e2e fixture 密碼由 gitignored fixtures 檔提供 — repo 內零密碼字串。 */
function readFixturePassword(): string {
  const file = path.join(process.cwd(), ".dev", "e2e-fixtures.txt");
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    console.error(`FATAL: 讀唔到 ${file} — 應含 H1_B_PASSWORD 行`);
    process.exit(1);
  }
  const line = content.split("\n").find((l) => l.startsWith("H1_B_PASSWORD="));
  const pw = line?.slice("H1_B_PASSWORD=".length).trim() ?? "";
  if (!pw) {
    console.error("FATAL: .dev/e2e-fixtures.txt 無 H1_B_PASSWORD 行");
    process.exit(1);
  }
  return pw;
}

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main() {
  const cmd = process.argv[2];
  const email = arg("--email");
  const clinic = arg("--clinic");
  const name = arg("--name", "E2E Staff");

  if (cmd === "create") {
    if (!email || !clinic) {
      console.error("usage: e2e:staff create --clinic <code> --email <email> [--name <name>]");
      process.exit(2);
    }
    const clinicRow = await prisma.clinic.findUnique({ where: { code: clinic } });
    if (!clinicRow) {
      console.error(`clinic ${clinic} not found`);
      process.exit(1);
    }
    // 冪等：已存在 → 重用（唔改 password — fixture 密碼首建時寫入）
    let staff = await prisma.staffUser.findUnique({ where: { email } });
    if (!staff) {
      const hash = await argon2.hash(readFixturePassword());
      staff = await prisma.staffUser.create({
        data: { email, name, role: "STAFF", clinicId: clinicRow.id, passwordHash: hash, active: true },
      });
    }
    // cwi-h6-20260830：StaffClinic 綁定行（login clinicIds 靠呢行；冪等 upsert）
    await prisma.staffClinic.upsert({
      where: { staffId_clinicId: { staffId: staff.id, clinicId: clinicRow.id } },
      update: { isPrimary: true },
      create: { staffId: staff.id, clinicId: clinicRow.id, isPrimary: true },
    });
    console.log(`STAFF_ID=${staff.id}`);
    return;
  }

  if (cmd === "delete") {
    if (!email) {
      console.error("usage: e2e:staff delete --email <email>");
      process.exit(2);
    }
    const staff = await prisma.staffUser.findUnique({ where: { email } });
    if (!staff) {
      console.log("STAFF_GONE=1");
      return;
    }
    const sid = staff.id;
    // 清 FK 引用（plain string ID — 逐表刪）
    await prisma.noteReadReceipt.deleteMany({ where: { staffId: sid } });
    await prisma.message.deleteMany({ where: { sentByStaffId: sid } });
    await prisma.auditLog.deleteMany({ where: { staffId: sid } });
    await prisma.conversation.updateMany({ where: { assigneeId: sid }, data: { assigneeId: null } });
    await prisma.staffUser.delete({ where: { id: sid } });
    console.log("STAFF_DELETED=1");
    return;
  }

  console.error("usage: e2e:staff <create|delete> ...");
  process.exit(2);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
