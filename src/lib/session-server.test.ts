/**
 * FX-04 unit test — server 路徑 session gate（QA-04：enroll-only session 封鎖）
 *
 * 運行：TZ=UTC npx tsx --test src/lib/session-server.test.ts
 *   （要 DB + Redis：isStaffActive 打 DB（wa_p2）、isStaffSessionCurrent 打 Redis）
 *
 * 背景（QA-04 已重現）：未 enroll ADMIN 登入後 session.enrollOnly=true，
 * 舊 getServerSession 只查 fresh/active/current/denied — enrollOnly session 係 fresh →
 * /inbox 回 200 且 HTML 含病人電話同名。修：server 完整 session gate 拒 enrollOnly，
 * enroll 頁另開 getEnrollSession（只接受 enrollOnly）。
 *
 * 呢度直調拆出嘅 gate 函數（validateServerSession / validateEnrollSession），
 * 唔起 server（redline：unit test only）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { closeRedis } from "@/lib/queue";
import { isSessionFresh, type SessionData } from "@/lib/session";
import { validateServerSession, validateEnrollSession } from "./session-server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** npx tsx 唔自動載 .env — 未設時從 repo root 補（唔覆蓋已有值）。 */
function ensureEnv(): void {
  try {
    const env = readFileSync(path.resolve(__dirname, "../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* 冇 .env → 下游斷言會 fail loud */
  }
}
ensureEnv();

const prisma = new PrismaClient();
let adminId: string;

before(async () => {
  const admin = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  assert.ok(admin, "seed 要有 admin");
  adminId = admin.id;
});

after(async () => {
  await closeRedis();
  await prisma.$disconnect();
});

function fakeSession(over: Partial<SessionData> = {}): SessionData {
  return {
    staffId: adminId,
    email: "admin@wa-clinic.local",
    name: "FX04 Test",
    role: "ADMIN",
    clinicId: null,
    loginAt: Date.now(),
    // 唔設 sid — 舊 session 形態（isSessionDenied(undefined) = false）
    ...over,
  };
}

// ── validateServerSession（getServerSession 核心）──────────────────────

test("fresh 正常 ADMIN session → validateServerSession = true", async () => {
  assert.equal(await validateServerSession(fakeSession()), true);
});

test("FX-04 核心：enrollOnly session → validateServerSession = false（唔准入 /inbox 等 server 頁）", async () => {
  assert.equal(await validateServerSession(fakeSession({ enrollOnly: true })), false);
});

test("過 role TTL 嘅 ADMIN session（loginAt 13h 前）→ false", async () => {
  assert.equal(await validateServerSession(fakeSession({ loginAt: Date.now() - 13 * 3600_000 })), false);
});

test("無 staffId → false（fail-closed）", async () => {
  assert.equal(await validateServerSession(fakeSession({ staffId: "" })), false);
});

// ── validateEnrollSession（getEnrollSession 核心 — 只接受 enrollOnly）──────

test("enrollOnly fresh session → validateEnrollSession = true", async () => {
  assert.equal(await validateEnrollSession(fakeSession({ enrollOnly: true })), true);
});

test("正常 session（非 enrollOnly）→ validateEnrollSession = false（enroll 頁唔服務正常 session）", async () => {
  assert.equal(await validateEnrollSession(fakeSession()), false);
});

test("enrollOnly 但出咗 15min 窗口（loginAt 16min 前）→ false", async () => {
  assert.equal(await validateEnrollSession(fakeSession({ enrollOnly: true, loginAt: Date.now() - 16 * 60_000 })), false);
});

// ── isSessionFresh TTL 語義（revalidate 同 gate 共用）───────────────────

test("isSessionFresh：enrollOnly 15min 窗口（14min 內 = fresh；16min = 過期）", () => {
  assert.equal(isSessionFresh({ role: "ADMIN", loginAt: Date.now() - 14 * 60_000, enrollOnly: true }), true);
  assert.equal(isSessionFresh({ role: "ADMIN", loginAt: Date.now() - 16 * 60_000, enrollOnly: true }), false);
});

test("isSessionFresh：ADMIN 12h role TTL（11h = fresh；13h = 過期）", () => {
  assert.equal(isSessionFresh({ role: "ADMIN", loginAt: Date.now() - 11 * 3600_000 }), true);
  assert.equal(isSessionFresh({ role: "ADMIN", loginAt: Date.now() - 13 * 3600_000 }), false);
});

test("isSessionFresh：無 loginAt → false（fail-closed）", () => {
  assert.equal(isSessionFresh({ role: "ADMIN", loginAt: undefined as unknown as number }), false);
});
