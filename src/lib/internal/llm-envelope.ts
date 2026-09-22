// ★ cwi-final S2-9：workforce ⇄ wa-inbox 臨床文字信封（AES-256-GCM；AAD 綁 v|kid|ts|nonce|context）
// 兩個 repo 必須逐字一致 — 改一邊要同步改另一邊（CI：兩邊各有同一組 test vector）
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface Envelope { v: 1; kid: string; ts: number; nonce: string; iv: string; ct: string; tag: string }

function deriveKey(secretB64: string): Buffer {
  const raw = Buffer.from(secretB64, "base64");
  if (raw.length < 32) throw new Error("INTERNAL_LLM_SECRET must be >= 32 bytes (base64)");
  return Buffer.from(hkdfSync("sha256", raw, Buffer.from("cwi-llm-extract"), Buffer.from("v1"), 32));
}
function aad(e: Pick<Envelope, "v" | "kid" | "ts" | "nonce">, context: string): Buffer {
  return Buffer.from(`${e.v}|${e.kid}|${e.ts}|${e.nonce}|${context}`, "utf8");
}

export function seal(secretB64: string, kid: string, body: unknown, context: string, nonce?: string): Envelope {
  const head = { v: 1 as const, kid, ts: Date.now(), nonce: nonce ?? randomBytes(16).toString("base64url") };
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(secretB64), iv);
  c.setAAD(aad(head, context));
  const ct = Buffer.concat([c.update(JSON.stringify(body), "utf8"), c.final()]);
  return { ...head, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

/** tag 唔啱 → throw（唔好將 error message 回俾 caller／入 log） */
export function open<T>(secretB64: string, e: Envelope, context: string): T {
  const d = createDecipheriv("aes-256-gcm", deriveKey(secretB64), Buffer.from(e.iv, "base64"));
  d.setAAD(aad(e, context));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  const pt = Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

export const REQ_CONTEXT = "req:llm-extract";
export const respContext = (reqNonce: string) => `resp:llm-extract:${reqNonce}`;
