import { type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { inboundQueue } from "@/lib/queue";
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
 * HMAC-SHA256 驗簽。
 * Meta 傳 `x-hub-signature-256: sha256=<hex>`（可能連其他 algo 一齊傳，用 comma 分隔）。
 * timingSafeEqual 要求 buffer 等長 — 長度唔同直接 false（唔好俾佢 throw）。
 */
function verifySignature(rawBody: string, header: string): boolean {
  const appSecret = process.env.WA_APP_SECRET;
  if (!appSecret || !header) return false;

  const sha256Part = header
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.startsWith("sha256="));
  if (!sha256Part) return false;

  const expected =
    "sha256=" +
    createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const a = Buffer.from(sha256Part);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Meta 驗證握手 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  if (
    p.get("hub.mode") === "subscribe" &&
    p.get("hub.verify_token") === process.env.WA_VERIFY_TOKEN &&
    p.get("hub.verify_token") !== undefined
  ) {
    return new Response(p.get("hub.challenge"), { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

/** 事件入隊 — 極速回 200 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256") ?? "";

  if (!verifySignature(raw, sig)) {
    // 快速 401 — log 只記 metadata（request size / 有冇 signature），唔記 body
    log.warn(
      { bodyLen: raw.length, hasSig: sig.length > 0 },
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

  try {
    await Promise.race([
      inboundQueue.add("event", event as object),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`enqueue timeout ${ENQUEUE_TIMEOUT_MS}ms`)),
          ENQUEUE_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err) {
    // queue fail（Redis 死 / 塞）：快速 500 令 Meta 重試。
    // 重試由 WebhookEvent 冪等層（Phase 1）去重，唔會重複處理。
    log.error(
      { bodyLen: raw.length, err: err instanceof Error ? err.message : String(err) },
      "webhook: enqueue failed"
    );
    return new Response("queue unavailable", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
