/**
 * WhatsApp Flow data_exchange 加密（MD §8.2 樣板碼 — 照實）
 *
 * Request（WhatsApp → 我哋 server）：
 *   request_json = { payload: b64, iv: b64, key_id: kid, phone_number_id, wa_id, conversation_id }
 *   - AES key (16B) 由 RSA-OAEP(SHA-256) wrap 住：用私鑰 unwrap
 *   - body = AES-128-GCM；payload layout = base64( ciphertext ‖ authTag(16B) )，iv 獨立字段
 *
 * Response（我哋 server → WhatsApp）：
 *   response_json = { payload: b64, iv: b64, key_id }
 *   - 同一把 AES key（每次 request 由 WhatsApp 新 wrap 一次）
 *   - ★★ IV bitwise-NOT 取反：response iv = 逐 byte ~byte & 0xFF 取 request iv（MD §8.2 明言嘅 WhatsApp 怪癖）
 *
 * Keypair：RSA-2048，首次生成持久化到 FLOW_KEYS_DIR（預設 .dev/flow-keys/）：
 *   private.pem (0600) / public.pem / keypair.json { kid, publicJwk }
 *   - mock mode：公鑰唔上傳（真 mode：POST /{phone_number_id}/whatsapp_business_encryption）
 *
 * 呢個 module 係 **pure node:crypto**（零 @/ import）— scripts/mock-flow-client.ts
 * 可以直接相對路徑 import 用同一套加密（round-trip 測試同一把 key）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── base64url helpers（JWT 用） ──────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

// ── RSA-2048 keypair（首次生成存 file） ──────────────────────────────────

export interface FlowKeypair {
  kid: string;
  privatePem: string;
  publicPem: string;
  publicJwk: Record<string, unknown>;
}

export function defaultKeysDir(): string {
  return path.resolve(process.cwd(), process.env.FLOW_KEYS_DIR ?? ".dev/flow-keys");
}

export function ensureKeypair(dir: string = defaultKeysDir()): FlowKeypair {
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, "keypair.json");
  const privPath = path.join(dir, "private.pem");
  const pubPath = path.join(dir, "public.pem");
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
      kid: string;
      publicJwk: Record<string, unknown>;
    };
    const privatePem = fs.readFileSync(privPath, "utf8");
    const publicPem = fs.readFileSync(pubPath, "utf8");
    if (meta.kid && privatePem && publicPem) return { ...meta, privatePem, publicPem };
  } catch {
    /* first boot → generate below */
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicJwk = crypto.createPublicKey(privateKey).export({ format: "jwk" }) as Record<string, unknown>;
  const kid = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });
  fs.writeFileSync(metaPath, JSON.stringify({ kid, publicJwk }, null, 2), { mode: 0o644 });
  return { kid, privatePem: privateKey, publicPem: publicKey, publicJwk };
}

// ── RSA-OAEP(SHA-256) AES key wrap/unwrap ───────────────────────────────

export function unwrapAesKey(privatePem: string, wrappedB64: string): Buffer {
  const key = crypto.privateDecrypt(
    { key: privatePem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(wrappedB64, "base64")
  );
  if (key.length !== 16) throw new Error("FLOW_BAD_AES_KEY_LEN");
  return key;
}

/** mock client 用：用我哋公鑰 wrap 一把新 AES-128 key（模擬 WhatsApp 行為）。 */
export function wrapAesKey(publicPem: string, key16: Buffer): string {
  return crypto
    .publicEncrypt(
      { key: publicPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      key16
    )
    .toString("base64");
}

// ── AES-128-GCM ─────────────────────────────────────────────────────────

/** payload layout: base64( ciphertext ‖ authTag(16B) )；iv 獨立字段。 */
export function decryptGcm(key16: Buffer, ivB64: string, payloadB64: string): string {
  const raw = Buffer.from(payloadB64, "base64");
  if (raw.length < 17) throw new Error("FLOW_BAD_PAYLOAD");
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-128-gcm", key16, Buffer.from(ivB64, "base64"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export function encryptGcm(key16: Buffer, iv: Buffer, json: unknown): { payload: string; iv: string } {
  const c = crypto.createCipheriv("aes-128-gcm", key16, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(json), "utf8"), c.final()]);
  return { payload: Buffer.concat([ct, c.getAuthTag()]).toString("base64"), iv: iv.toString("base64") };
}

/** ★ MD §8.2：response IV = bitwise-NOT 取反(request IV)（逐 byte ~byte & 0xFF） */
export function reversedIv(reqIvB64: string): Buffer {
  const iv = Buffer.from(reqIvB64, "base64");
  // Meta 真 spec：request IV = 16 bytes；12 bytes 保留俾 legacy 信封（mock step/complete）
  if (iv.length !== 12 && iv.length !== 16) throw new Error("FLOW_BAD_IV_LEN");
  return Buffer.from(iv.map((b) => ~b & 0xff));
}

// ── flow_token（HS256 JWT — 防別店/別對話用；node:crypto 手搓，零依賴） ──

export interface FlowTokenPayload {
  convId: string;
  clinicId: string;
  /** 每次發 Flow 唯一（防同對話第二個 flow 撞 @unique — 模擬 Meta token 嘅隨機性） */
  jti?: string;
}

export function signFlowToken(p: FlowTokenPayload, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(p)));
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyFlowToken(token: string, secret: string): FlowTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(fromB64url(parts[1]).toString("utf8")) as FlowTokenPayload;
    if (typeof p.convId !== "string" || typeof p.clinicId !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export function flowJwtSecret(): string {
  const s = process.env.FLOW_JWT_SECRET ?? "";
  if (s.length < 32) throw new Error("FLOW_JWT_SECRET missing（≥32 bytes）");
  return s;
}

// ── 真 mode：公鑰上傳 WhatsApp（mock mode 跳過） ─────────────────────────

/**
 * POST /{phone_number_id}/whatsapp_business_encryption — 註冊加密公鑰。
 * 真機對接時 boot 時行一次（README Phase 3 有步驟）。mock mode no-op。
 */
export async function uploadPublicKey(opts: {
  phoneNumberId: string;
  publicJwk: Record<string, unknown>;
  accessToken?: string;
}): Promise<{ mocked: boolean }> {
  if (process.env.WA_MOCK === "1") {
    return { mocked: true };
  }
  const token = opts.accessToken ?? process.env.WA_ACCESS_TOKEN ?? "";
  if (!token) throw new Error("WA_ACCESS_TOKEN missing");
  const res = await fetch(`https://graph.facebook.com/v23.0/${opts.phoneNumberId}/whatsapp_business_encryption`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ public_key: opts.publicJwk }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`uploadPublicKey failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return { mocked: false };
}
