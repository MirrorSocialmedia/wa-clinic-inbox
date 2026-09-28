/**
 * FX-02 unit test — prisma/seed.ts 嘅 ADMIN/SUPERVISOR scopeType 行為（QA-02）
 *
 * 運行：TZ=UTC npx tsx --test prisma/seed.test.ts
 *   （要 DB：migrate:deploy 過嘅 DATABASE_URL；npx 唔似 pnpm 自動注入 .env，
 *     所以 DATABASE_URL 未設時呢度自己讀 repo root .env — 唔會覆蓋已有 env）
 *
 * 驗收（workorder T762 本地部分）：fresh DB seed 後
 *   - admin@wa-clinic.local  = ALL
 *   - supervisor@…           = ALL
 *   - STAFF                  = CLINICS（schema default，語義唔變）
 * 加：repair path — 舊 DB 嘅 ADMIN 已被建做 CLINICS（空範圍）→ 重跑 seed 修復返 ALL。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { main as runSeed } from "./seed";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** npx tsx 唔自動載 .env — DATABASE_URL 未設時從 repo root 補（唔覆蓋已有值）。 */
function ensureDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const env = readFileSync(path.resolve(__dirname, "../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* 冇 .env → Prisma 會報錯，fail loud 得 */
  }
}
ensureDatabaseUrl();

const prisma = new PrismaClient();

after(async () => {
  await prisma.$disconnect();
});

const SEED_TIMEOUT = 180_000;

test(
  "fresh seed：ADMIN + SUPERVISOR = ALL；STAFF = CLINICS（default 唔變）",
  { timeout: SEED_TIMEOUT },
  async () => {
    await runSeed();

    const admin = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
    assert.ok(admin, "admin@wa-clinic.local 應該存在");
    assert.equal(admin.scopeType, "ALL", "ADMIN seed 出嚟必須係 ALL（唔係 schema default CLINICS）");

    const supv = await prisma.staffUser.findUnique({ where: { email: "supervisor@wa-clinic.local" } });
    assert.ok(supv, "supervisor@wa-clinic.local 應該存在");
    assert.equal(supv.scopeType, "ALL", "SUPERVISOR seed 出嚟必須係 ALL");

    const staff = await prisma.staffUser.findUnique({ where: { email: "staff-tkw@wa-clinic.local" } });
    assert.ok(staff, "staff-tkw 應該存在");
    assert.equal(staff.scopeType, "CLINICS", "STAFF 語義唔變（CLINICS + StaffClinic 行）");
  }
);

test(
  "repair：舊 DB 嘅 ADMIN 被建做 CLINICS（空範圍）→ 重跑 seed 修復返 ALL",
  { timeout: SEED_TIMEOUT * 2 },
  async () => {
    const admin = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
    assert.ok(admin, "前置：seed 應該已建 admin");

    // 模擬 QA-02 現況：ADMIN 帶住 schema default CLINICS（+ 零 StaffClinic = 空範圍）
    await prisma.staffUser.update({ where: { id: admin.id }, data: { scopeType: "CLINICS" } });

    await runSeed();

    const after = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
    assert.equal(after!.scopeType, "ALL", "重跑 seed 必須修復返 ALL");

    // 同場 SUPERVISOR 都修復（同一個 bug 來源）
    await prisma.staffUser.update({
      where: { email: "supervisor@wa-clinic.local" },
      data: { scopeType: "CLINICS" },
    });
    await runSeed();
    const supvAfter = await prisma.staffUser.findUnique({ where: { email: "supervisor@wa-clinic.local" } });
    assert.equal(supvAfter!.scopeType, "ALL", "SUPERVISOR 重跑 seed 必須修復返 ALL");

    // STAFF 唔應該被 scope repair 牽連（CLINICS 係佢哋正常值）
    const staff = await prisma.staffUser.findUnique({ where: { email: "staff-mf@wa-clinic.local" } });
    assert.equal(staff!.scopeType, "CLINICS", "STAFF 唔應該被當 privileged 修復");
  }
);
