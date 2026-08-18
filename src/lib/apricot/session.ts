/**
 * Apricot session — cookie 三件套存取（★ 移植 clinic-workforce-mvp token.ts 核心邏輯，原封不動）
 *
 * 機制（provider-roster 已實測）：
 * - 登入態 = 三隻 cookie：access_token（JWT，~10h）/ refresh_token（7 日 sliding window，
 *   rotating）/ iat（server 發）。
 * - 每次 response 可能帶**多隻** Set-Cookie（rotation）— 攞全部用 `getSetCookie()`
 *   （`get('set-cookie')` 只回第一隻 = 炒車，MD §8.1 明言）。
 * - 三件套 AES-256-GCM 加密後存 ApricotSession（singleton id=1）；
 *   APRICOT_ENC_KEY = 32-byte base64。
 * - 唔做 module-level memo — rotation 之後 memo 會過期（reference 鐵律）。
 *
 * ★ PII：token 係 session 憑證 — 只加密存 DB；log 只准 metadata（rotated?/lastSyncAt）。
 */
import crypto from "node:crypto";
import prisma from "@/lib/prisma";

function requireKey(): Buffer {
  const k = Buffer.from(process.env.APRICOT_ENC_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("APRICOT_ENC_KEY 必須係 32-byte base64");
  return k;
}

export type ApricotCreds = { accessToken: string; refreshToken: string; iat: string };

function enc(plain: string): string {
  const key = requireKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function dec(b64: string): string {
  const key = requireKey();
  const raw = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/** 讀 session（null = 未設定）。★ 每次 fresh 讀 — 唔 memo（rotation）。 */
export async function loadCreds(): Promise<ApricotCreds | null> {
  const row = await prisma.apricotSession.findUnique({ where: { id: 1 } });
  if (!row) return null;
  const c = JSON.parse(dec(row.accessTokenEnc)) as ApricotCreds; // accessTokenEnc 存 JSON 三件套
  if (!c.accessToken || !c.refreshToken || !c.iat) return null;
  return c;
}

export interface SessionPatch {
  refreshExpiry?: Date;
  lastSyncAt?: Date;
  lastKeepaliveAt?: Date;
  lastError?: string | null;
  /** rotation 次數增量（預設 1 — 每次 save 代表攞咗新 cookie） */
  rotate?: boolean;
}

/** 寫 session（encryption at rest）。寫入失敗一定要 throw 上嚟（reference 鐵律）。 */
export async function saveCreds(c: ApricotCreds, patch: SessionPatch = {}): Promise<void> {
  await prisma.apricotSession.upsert({
    where: { id: 1 },
    update: {
      accessTokenEnc: enc(JSON.stringify(c)),
      refreshTokenEnc: c.refreshToken ? enc(c.refreshToken) : undefined,
      iatEnc: c.iat ? enc(c.iat) : undefined,
      ...(patch.lastSyncAt ? { lastSyncAt: patch.lastSyncAt } : {}),
      ...(patch.lastKeepaliveAt ? { lastKeepaliveAt: patch.lastKeepaliveAt } : {}),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      ...(patch.rotate === false ? {} : { rotationCount: { increment: 1 } }),
    },
    create: {
      id: 1,
      accessTokenEnc: enc(JSON.stringify(c)),
      refreshTokenEnc: enc(c.refreshToken),
      iatEnc: enc(c.iat),
      ...(patch.lastSyncAt ? { lastSyncAt: patch.lastSyncAt } : {}),
      ...(patch.lastKeepaliveAt ? { lastKeepaliveAt: patch.lastKeepaliveAt } : {}),
      ...(patch.lastError ? { lastError: patch.lastError } : {}),
    },
  });
}

/** 記錯誤（metadata 短句；唔存 raw response）。失敗唔 throw（监控路徑唔阻主流程）。 */
export async function markError(msg: string): Promise<void> {
  await prisma.apricotSession
    .upsert({
      where: { id: 1 },
      update: { lastError: msg.slice(0, 500) },
      create: {
        id: 1,
        accessTokenEnc: enc(JSON.stringify({ accessToken: "", refreshToken: "", iat: "" })),
        refreshTokenEnc: enc(""),
        iatEnc: enc(""),
        lastError: msg.slice(0, 500),
      },
    })
    .catch((e) => console.error("[apricot] markError 失敗", e?.message));
}

export function apricotMock(): boolean {
  return process.env.APRICOT_MOCK === "1";
}

/**
 * Mock mode bootstrap：APRICOT_MOCK=1 時確保有 session row（決定性 mock token）。
 * E2E / 本地開發用；real mode 唔會行呢度（真 session 由 bot 帳號登入流程寫入）。
 */
export async function ensureMockSession(): Promise<ApricotCreds> {
  const existing = await loadCreds();
  if (existing) return existing;
  const mock: ApricotCreds = {
    accessToken: "mock-apricot-access-jwt",
    refreshToken: "mock-apricot-refresh-token",
    iat: String(Math.floor(Date.now() / 1000)),
  };
  await saveCreds(mock, { rotate: false });
  return mock;
}
