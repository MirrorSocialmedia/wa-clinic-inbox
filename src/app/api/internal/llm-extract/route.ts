import { type NextRequest, NextResponse } from "next/server";
import log from "@/lib/log";
import { getRedis } from "@/lib/queue";
import { open, seal, REQ_CONTEXT, respContext, type Envelope } from "@/lib/internal/llm-envelope";
import { extractQuoteItems, type TermLite } from "@/lib/internal/quote-llm";

/**
 * ★ cwi-final S2-9（D-2）：workforce 報價抽取 proxy。
 * 🔴 鐵律：臨床全文唔准落地 — 呢個 route 唔准 import prisma、唔准 log body／items 內容、唔准 cache。
 *    唔用 handle()（佢會 log error message）。任何 error 只回原因碼。
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 64_000;
const MAX_TERMS = 500;
const CONCURRENCY = Math.max(1, Number(process.env.LLM_PROXY_CONCURRENCY ?? 1));
let inflight = 0;

const deny = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: code, ...extra }, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const secret = process.env.INTERNAL_LLM_SECRET;
  const kid = process.env.INTERNAL_LLM_KID ?? "k1";
  if (!secret || process.env.LLM_PROXY_ENABLED !== "1") return deny(503, "NOT_ENABLED");

  const raw = await req.text();
  if (raw.length > MAX_BODY) return deny(413, "TOO_LARGE");
  let env: Envelope;
  try { env = JSON.parse(raw) as Envelope; } catch { return deny(400, "BAD_JSON"); }
  if (env?.v !== 1 || env.kid !== kid || typeof env.nonce !== "string" || env.nonce.length > 64) return deny(401, "BAD_ENVELOPE");
  if (!Number.isFinite(env.ts) || Math.abs(Date.now() - env.ts) > 60_000) return deny(401, "STALE");

  let payload: { notePlain?: unknown; terms?: unknown };
  try { payload = open(secret, env, REQ_CONTEXT); } catch { log.warn({ kid }, "llm-extract: bad tag"); return deny(401, "BAD_TAG"); }

  // 重放保護（tag 驗過先記 nonce — 防人用垃圾 nonce 塞爆 Redis）
  try {
    const ok = await getRedis().set(`llmx:nonce:${env.nonce}`, "1", "EX", 180, "NX");
    if (ok === null) return deny(409, "REPLAY");
  } catch { return deny(503, "REDIS_DOWN"); }

  const notePlain = typeof payload.notePlain === "string" ? payload.notePlain.slice(0, 2000) : null;
  const terms = Array.isArray(payload.terms)
    ? (payload.terms as TermLite[]).slice(0, MAX_TERMS).filter((t) => t && typeof t.shorthand === "string" && t.shorthand.length <= 32 && typeof t.nameCn === "string" && t.nameCn.length <= 64)
    : null;
  if (!notePlain || !terms || terms.length === 0) return deny(400, "BAD_PAYLOAD");

  if (inflight >= CONCURRENCY) return deny(429, "BUSY", { retryAfterSec: 5 });
  inflight++;
  try {
    const r = await extractQuoteItems(notePlain, terms);
    const resp = seal(secret, kid, { items: r.items, reason: r.reason }, respContext(env.nonce));
    // ★ 只 log metadata
    log.info({ lenIn: notePlain.length, terms: terms.length, items: r.items?.length ?? null, reason: r.reason, ms: Date.now() - t0 }, "llm-extract: done");
    return NextResponse.json(resp, { headers: { "cache-control": "no-store" } });
  } finally {
    inflight--;
  }
}
