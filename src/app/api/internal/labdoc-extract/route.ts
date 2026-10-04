import { type NextRequest, NextResponse } from "next/server";
import log from "@/lib/log";
// ★ 同 llm-extract：request 路徑用有 commandTimeout 嘅 client（Redis 斷線唔會令請求吊死）
import { getAppRedis as getRedis } from "@/lib/queue";
import { open, seal, respContext, type Envelope } from "@/lib/internal/llm-envelope";
import {
  REQ_CONTEXT_LABDOC,
  countPages,
  extractLabDoc,
  validateLabDocRequest,
  LabDocValidationError,
} from "@/lib/internal/labdoc-llm";

/**
 * ★ cwi-labdoc-extract（施工單 cwm-labdoc §5.2）：workforce 讀單 proxy。
 * 🔴 鐵律（2026-09-17 決定）：唔寫 DB、唔寫檔、唔 log 原文 —
 *    呢個 route 唔准 import prisma、唔准 log body／text／images 內容、唔准 cache。
 *    任何 error 只回原因碼；log 只記 metadata（mode / 頁數 / 字數 / 圖數 / reason / ms）。
 *    靜態鎖：scripts/check-internal-no-persist.sh。
 *
 * 信封：AES-256-GCM（llm-envelope，兩 repo 逐字一致）；REQ_CONTEXT = "labdoc-extract.v1"，
 * 回應 respContext(nonce)。重放保護：Redis nonce 180s NX（同 llm-extract 模式）。
 * body 上限 12 MB（超 → 413 TOO_LARGE，喺 JSON parse 之前檢查；嚴-byte 語義 = Buffer.byteLength）。
 * nonce 消耗口徑（M-1，2026-10-04 reviewer 修復）：只有已認證（tag 合法）+ 合法 payload
 * 先消耗 nonce — 429 BUSY 發生時 nonce 未 SET，CWM 重試同一信封會得 429（可重試）而唔係 409 REPLAY。
 *
 * 回應（密文內）：{ result: §5.4 JSON | null, reason: "breaker_open"|"llm_error"|"parse_error"|"bad_response"|"mock"|null }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 12 * 1024 * 1024; // 12 MB（§5.2）
const CONCURRENCY = Math.max(1, Number(process.env.LABDOC_LLM_CONCURRENCY ?? 1));
let inflight = 0;

const deny = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: code, ...extra }, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const secret = process.env.INTERNAL_LLM_SECRET;
  const kid = process.env.INTERNAL_LLM_KID ?? "k1";
  if (!secret || process.env.LLM_PROXY_ENABLED !== "1") return deny(503, "NOT_ENABLED");

  // ★ 12MB body 上限：先查 content-length（HTTP 層）— 唔靠 req.text() 攞到全文
  //   （實測：真網絡大 body 經 Next dev 會截斷/緩衝 → 截斷後 JSON.parse 先失敗 → 誤回 400 BAD_JSON；
  //    in-process NextRequest 全文在內存先會行到下方 byteLength 兜底檢查）。
  //   content-length 齊先查；冇（chunked）就落到下方 byteLength 兜底。
  const clRaw = req.headers.get("content-length");
  if (clRaw !== null) {
    const cl = Number(clRaw);
    if (Number.isFinite(cl) && cl > MAX_BODY) return deny(413, "TOO_LARGE");
  }
  const raw = await req.text();
  // ★ m-1（2026-10-04 reviewer 修復）：嚴-byte 語義 — raw.length 係 UTF-16 code units，
  //   astral 字元密集 body 理論上可達 ~2× 上限先觸發；改 Buffer.byteLength。
  if (Buffer.byteLength(raw) > MAX_BODY) return deny(413, "TOO_LARGE");
  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch {
    return deny(400, "BAD_JSON");
  }
  if (env?.v !== 1 || env.kid !== kid || typeof env.nonce !== "string" || env.nonce.length > 64) {
    return deny(401, "BAD_ENVELOPE");
  }
  if (!Number.isFinite(env.ts) || Math.abs(Date.now() - env.ts) > 60_000) return deny(401, "STALE");

  let payload: unknown;
  try {
    payload = open(secret, env, REQ_CONTEXT_LABDOC);
  } catch {
    log.warn({ kid }, "labdoc-extract: bad tag");
    return deny(401, "BAD_TAG");
  }

  // Payload 驗證（仍在 nonce SET 之前 — DoS 保護唔變：垃圾 payload 唔消耗 nonce）
  let request;
  try {
    request = validateLabDocRequest(payload);
  } catch (e) {
    if (e instanceof LabDocValidationError) return deny(400, "BAD_PAYLOAD", { detail: e.message });
    log.warn("labdoc-extract: unexpected validate error");
    return deny(500, "INTERNAL");
  }

  // ★ M-1（2026-10-04 reviewer 修復）：concurrency check 移到 nonce SET 之前 —
  //   429 BUSY 唔消耗 nonce：CWM client 重試同一信封會得 429（可重試）而唔係永久 409 REPLAY。
  //   只有已認證（tag 合法）+ 合法 payload 嘅請求先會消耗 nonce。
  //   inflight++ 同 check 相鄰（中間無 await）→ 嚴格並發上限唔變。
  if (inflight >= CONCURRENCY) return deny(429, "BUSY", { retryAfterSec: 5 });
  inflight++;
  try {
    // 重放保護（tag 驗過先記 nonce — 防人用垃圾 nonce 塞爆 Redis）
    let ok: "OK" | null;
    try {
      ok = await getRedis().set(`labdocx:nonce:${env.nonce}`, "1", "EX", 180, "NX");
    } catch {
      return deny(503, "REDIS_DOWN");
    }
    if (ok === null) return deny(409, "REPLAY");

    const { result, reason } = await extractLabDoc(request);
    const resp = seal(secret, kid, { result, reason }, respContext(env.nonce));
    // ★ 只 log metadata（鐵律：原文／images 永不入 log）
    log.info(
      {
        mode: request.mode,
        kind: request.kindHint,
        pages: request.text !== null ? countPages(request.text) : null,
        chars: request.text?.length ?? null,
        images: request.images?.length ?? null,
        hasResult: result !== null,
        reason,
        ms: Date.now() - t0,
      },
      "labdoc-extract: done"
    );
    return NextResponse.json(resp, { headers: { "cache-control": "no-store" } });
  } finally {
    inflight--;
  }
}
