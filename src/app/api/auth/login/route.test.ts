/**
 * FX-14 unit test — TOTP 防重放原子化（QA-14）
 *
 * 運行：TZ=UTC npx tsx --test src/app/api/auth/login/route.test.ts
 *   （要 Redis（本地 6379）+ DB（wa_p2 建測試用戶）+ TOTP_ENC_KEY（.env））
 *
 * 背景：login route 舊實作 `GET totp:last` → 比較 → `SET totp:last` 非原子 →
 * 同一 code 兩個並發請求都讀到舊 last → 都過。修：驗證成功後
 * `SET totp:used:<staffId>:<step> 1 EX 120 NX`（返回 null = 已被攞 → 401），
 * 保留「step 唔准倒退」（totp:last）檢查。
 *
 * 呢度直調拆出嘅 verifyTotpStep（gate 層）— 唔起 server（redline）。
 * T766 口徑：同 code 並發 2 個 → 1 × ok + 1 × replay（HTTP 層 = 1×200 + 1×401，
 * handler 對 !v.ok 一律 401/totpfail，唔會分支）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { closeRedis, getRedis } from "@/lib/queue";
import { generateTotpSecret, totpCode, matchedTotpStep } from "@/lib/totp";
import { encryptTotpSecret } from "@/lib/totp-enc";
import { verifyTotpStep } from "./route";

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

const TEST_USER_ID = "fx14user000000000000000001"; // 固定 id（cleanup 用）
let secret: string;
let codeNow: string; // 目前 step 嘅有效 code
let codeNext: string; // +1 step（合法再用）

async function delTotpKeysFor(userId: string): Promise<void> {
  const r = getRedis();
  await r.del(`totp:last:${userId}`, `totpfail:${userId}`);
  // totp:used:<userId>:<step> — step 會漂，SCAN 自己用戶嘅 prefix 洗（只洗自己，零 PII）
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", `totp:used:${userId}:*`, "COUNT", 100);
    cursor = next;
    if (keys.length > 0) await r.del(...keys);
  } while (cursor !== "0");
}

before(async () => {
  assert.ok(process.env.TOTP_ENC_KEY, "TOTP_ENC_KEY 要喺 .env");
  await delTotpKeysFor(TEST_USER_ID);
  await prisma.staffUser.deleteMany({ where: { id: TEST_USER_ID } });
  secret = generateTotpSecret();
  const now = Date.now();
  const sNow = Math.floor(now / 1000 / 30);
  codeNow = totpCode(secret, sNow * 30_000);
  codeNext = totpCode(secret, (sNow + 1) * 30_000);
  // 前置 sanity：兩個 code 各自匹配到預期 step（±1 window 內最大 step）
  assert.equal(matchedTotpStep(secret, codeNow, sNow * 30_000), sNow);
  assert.equal(matchedTotpStep(secret, codeNext, sNow * 30_000), sNow + 1);
  await prisma.staffUser.create({
    data: {
      id: TEST_USER_ID,
      email: "fx14@test.local",
      name: "FX14 Test",
      role: "STAFF",
      passwordHash: await argon2.hash("test-pass-123"),
      active: true,
      totpSecretEnc: encryptTotpSecret(secret),
    },
  });
});

after(async () => {
  await delTotpKeysFor(TEST_USER_ID);
  await prisma.staffUser.deleteMany({ where: { id: TEST_USER_ID } });
  await closeRedis();
  await prisma.$disconnect();
});

test("T766：同 code 並發 2 個 → 恰 1 × ok + 1 × replay（NX 原子 claim）", async () => {
  // 確保乾淨起點
  await delTotpKeysFor(TEST_USER_ID);
  const [a, b] = await Promise.all([
    verifyTotpStep(TEST_USER_ID, secret, codeNow),
    verifyTotpStep(TEST_USER_ID, secret, codeNow),
  ]);
  const oks = [a, b].filter((r) => r.ok).length;
  const replays = [a, b].filter((r) => !r.ok && (r as { reason: string }).reason === "replay").length;
  assert.equal(oks, 1, `並發 2 個同 code 應該恰 1 個過（實際 ok=${oks}）`);
  assert.equal(replays, 1, `並發 2 個同 code 應該恰 1 個 replay（實際=${replays}）`);
});

test("同一 code 序再用 → 拒（step <= totp:last 倒退守衛）", async () => {
  // 用 codeNow（test 1 已用 step）：matched step 必 <= last → replay。
  // （極罕見 30s 邊界 double-cross 會變 "bad" — 兩者都係「拒」，斷 !ok 即夠）
  const r = await verifyTotpStep(TEST_USER_ID, secret, codeNow);
  assert.equal(r.ok, false, "已用 code 唔應該再用過");
  if (!r.ok) assert.ok(r.reason === "replay" || r.reason === "bad");
});

test("錯 code → bad", async () => {
  const wrong = codeNow === "000000" ? "000001" : "000000";
  const r = await verifyTotpStep(TEST_USER_ID, secret, wrong);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad");
});

test("新 step（+1）合法再用 → ok（唔會誤擋正常連續登入）", async () => {
  const r = await verifyTotpStep(TEST_USER_ID, secret, codeNext);
  assert.equal(r.ok, true, "+1 step 係合法嘅新 step");
});

test("倒退 step（用回 test 1 已用 step，而 last 已推進）→ 拒（totp:last 倒退檢查）", async () => {
  // test 4 用咗 +1 step（last 已推進）— 再用 codeNow（較舊 step）必被 totp:last 擋。
  // 呢個斷言對 30s 邊界單次 crossing 都穩定（codeNow 喺 ±1 window 內永遠 match 到自己個 step）。
  const r = await verifyTotpStep(TEST_USER_ID, secret, codeNow);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "replay");
});
