import { type NextRequest } from "next/server";
import { inboundQueue } from "@/lib/queue";
import { verifyWaSignature } from "@/lib/wa-signature";
import log from "@/lib/log";

/**
 * Meta WhatsApp Cloud API webhook — 框架 MD §6.1
 *
 * GET  : Meta 驗證握手（hub.challenge）
 * POST : 驗簽 → 入 inbound queue → 極速 200。
 *        ★ 唔喺 request 內處理業務 — 全部交 worker。
 *        ★ Meta 收到非 2xx / 太慢會重發 + 降權：任何路徑都要快。
 *
 * ★ PII 鐵律：payload 原文永不入 log（只 log size / 結構 metadata）。
 */
export const dynamic = "force-dynamic";

/** queue.add 最多等咁耐 — Redis 死咗都唔好吊住 request（iron rule 5） */
const ENQUEUE_TIMEOUT_MS = 1500;

/**
 * body 上限（bytes）。WA payload 一般 KB 級；公網 endpoint 唔限 size = 內存 DoS 入口。
 * 超上限 → 413（Meta 唔會送超過 1MB 嘅合法 payload）。
 */
const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {
  constructor(
    public size: number
  ) {
    super(`body too large: ${size} bytes`);
    this.name = "BodyTooLarge";
  }
}

/**
 * 讀 body 帶硬上限 — 同時 cover content-length 同 chunked transfer：
 * - content-length 声明 > 上限 → 唔讀直接 413
 * - chunked（無 content-length）→ streaming 讀，累計超上限即 cancel
 */
async function readCappedBody(req: NextRequest): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLarge(declared);
  }
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge(size);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

/** Meta 驗證握手 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const verifyToken = p.get("hub.verify_token");
  if (
    p.get("hub.mode") === "subscribe" &&
    verifyToken &&
    verifyToken === process.env.WA_VERIFY_TOKEN
  ) {
    return new Response(p.get("hub.challenge"), { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

/** 事件入隊 — 極速回 200 */
export async function POST(req: NextRequest) {
  let raw: string;
  try {
    raw = await readCappedBody(req);
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      log.warn({ bytes: err.size }, "webhook: body too large");
      return new Response("too large", { status: 413 });
    }
    throw err; // 真正嘅讀取錯誤 → 500，Meta 會重試
  }

  const sig = req.headers.get("x-hub-signature-256");
  if (!verifyWaSignature(raw, sig, process.env.WA_APP_SECRET)) {
    // 快速 401 — log 只記 metadata（request size / 有冇 signature），唔記 body
    log.warn(
      { bodyLen: raw.length, hasSig: (sig ?? "").length > 0 },
      "webhook: bad signature"
    );
    return new Response("bad sig", { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    log.warn({ bodyLen: raw.length }, "webhook: invalid JSON");
    return new Response("bad json", { status: 400 });
  }

  let enqueueTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      inboundQueue.add("event", event as object),
      new Promise<never>((_, reject) => {
        enqueueTimer = setTimeout(
          () => reject(new Error(`enqueue timeout ${ENQUEUE_TIMEOUT_MS}ms`)),
          ENQUEUE_TIMEOUT_MS
        );
      }),
    ]);
  } catch (err) {
    // queue fail（Redis 死 / 塞）：快速 500 令 Meta 重試。
    // 重試由 WebhookEvent 冪等層（Phase 1）去重，唔會重複處理。
    log.error(
      { bodyLen: raw.length, err: err instanceof Error ? err.message : String(err) },
      "webhook: enqueue failed"
    );
    return new Response("queue unavailable", { status: 500 });
  } finally {
    if (enqueueTimer) clearTimeout(enqueueTimer);
  }

  return new Response("ok", { status: 200 });
}
