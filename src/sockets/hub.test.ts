/**
 * FX-04 unit test — socket 路徑 session gate（QA-04 socket 重現 + QA-15 revalidate）
 *
 * 運行：TZ=UTC npx tsx --test src/sockets/hub.test.ts
 *   （要 DB + Redis：isStaffActive 打 DB（wa_p2）、cutoff/deny 打 Redis）
 *
 * 背景（QA-04 已重現）：enrollOnly session 同一個 cookie → Socket.IO CONNECTED。
 * 修：io.use 加 enrollOnly → next(new Error("enroll required"))。
 * QA-15：revalidate 之前唔查 isSessionFresh → 過 TTL 嘅 socket 唔會斷。
 *
 * 用真 iron-session sealData 造 cookie（同 session-server 同一 secret/options），
 * 直調拆出嘅 checkSocketAuth / isSocketSessionStillValid — 唔起 server（redline）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealData } from "iron-session";
import { PrismaClient } from "@prisma/client";
import { closeRedis } from "@/lib/queue";
import { SESSION_COOKIE_NAME, sessionOptions, type SessionData } from "@/lib/session";
import { checkSocketAuth, isSocketSessionStillValid } from "./hub";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureEnv(): void {
  try {
    const env = readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* fail loud downstream */
  }
}
ensureEnv();

const prisma = new PrismaClient();
let adminId: string;

function fakeSession(over: Partial<SessionData> = {}): SessionData {
  return {
    staffId: adminId,
    email: "admin@wa-clinic.local",
    name: "FX04 Test",
    role: "ADMIN",
    clinicId: null,
    loginAt: Date.now(),
    ...over,
  };
}

/** 真 iron-session seal（同 getSocketSession unseal 同一 password/ttl）→ cookie header。 */
async function makeCookie(data: SessionData): Promise<string> {
  const sealed = await sealData(data as unknown as Record<string, unknown>, {
    password: process.env.SESSION_SECRET!,
    ttl: sessionOptions().ttl,
  });
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

before(async () => {
  const admin = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  assert.ok(admin, "seed 要有 admin");
  adminId = admin.id;
});

after(async () => {
  await closeRedis();
  await prisma.$disconnect();
});

// ── checkSocketAuth（io.use 核心）──────────────────────────────────────

test("無 cookie → unauthorized", async () => {
  const r = await checkSocketAuth({ headers: { cookie: "" } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "unauthorized");
});

test("壞 cookie（亂碼）→ unauthorized（fail-closed）", async () => {
  const r = await checkSocketAuth({ headers: { cookie: `${SESSION_COOKIE_NAME}=garbage!!!` } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "unauthorized");
});

test("正常 fresh session cookie → ok（session 通過）", async () => {
  const cookie = await makeCookie(fakeSession());
  const r = await checkSocketAuth({ headers: { cookie } });
  assert.equal(r.ok, true, "正常 session 應該可以 connect");
  if (r.ok) assert.equal(r.session.staffId, adminId);
});

test("FX-04 核心：enrollOnly session cookie → 'enroll required'（重現：之前 CONNECTED）", async () => {
  const cookie = await makeCookie(fakeSession({ enrollOnly: true }));
  const r = await checkSocketAuth({ headers: { cookie } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "enroll required");
});

test("過 role TTL 嘅 session cookie（13h）→ unauthorized（getSocketSession fresh 拒）", async () => {
  const cookie = await makeCookie(fakeSession({ loginAt: Date.now() - 13 * 3600_000 }));
  const r = await checkSocketAuth({ headers: { cookie } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "unauthorized");
});

// ── isSocketSessionStillValid（revalidate 核心）────────────────────────

test("fresh session → revalidate = true（唔斷）", async () => {
  assert.equal(await isSocketSessionStillValid(fakeSession()), true);
});

test("QA-15：過 TTL 嘅 session（loginAt 13h 前）→ revalidate = false（之前唔會斷）", async () => {
  assert.equal(await isSocketSessionStillValid(fakeSession({ loginAt: Date.now() - 13 * 3600_000 })), false);
});

test("enrollOnly session 出咗 15min 窗口 → revalidate = false", async () => {
  const s = fakeSession({ enrollOnly: true, loginAt: Date.now() - 16 * 60_000 });
  assert.equal(await isSocketSessionStillValid(s), false);
});

test("無 loginAt → revalidate = false（fail-closed）", async () => {
  assert.equal(await isSocketSessionStillValid(fakeSession({ loginAt: undefined as unknown as number })), false);
});
