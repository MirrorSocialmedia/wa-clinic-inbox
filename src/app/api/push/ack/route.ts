import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import prisma from "@/lib/prisma";

/**
 * POST /api/push/ack — ★ cwi-notify-a4（2026-10-02）：手機 service worker 收到 Web Push 後回報。
 *
 * 目的：診斷「推送服務收咗（lastOkAt）但部機有冇真係收到（lastReceivedAt）」— 兩者之間斷咗
 * = 手機端問題（省電／系統設定／訂閱失效），唔使再估。
 *
 * 身份：唔用 cookie（SW 喺 app 閂咗時觸發，session 可能已過期）— 靠 endpoint 本身：
 * push endpoint 係推送服務發嘅長隨機 URL（唔會出現喺任何頁面／log），只有持有該訂閱嘅瀏覽器知道。
 * 只更新該 row 嘅 lastReceivedAt；endpoint 唔存在 → 204（唔透露有冇呢個訂閱）。
 * Origin 守門照行（middleware：SW fetch 帶同站 Origin）。零 PII。
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint || endpoint.length > 2048) return new Response(null, { status: 204 });
  await prisma.pushSubscription
    .updateMany({ where: { endpoint }, data: { lastReceivedAt: new Date() } })
    .catch(() => undefined);
  return new Response(null, { status: 204 });
});
