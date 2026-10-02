import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import prisma from "@/lib/prisma";
import { vapidPublicKey } from "@/lib/push";

/**
 * GET /api/push/devices — ★ cwi-notify-a4（2026-10-02）：我自己名下嘅推送訂閱（通知設定面板「推送診斷」）。
 *
 * 每部機：裝置名（由 userAgent 簡化）、訂閱時間、推送服務最後收貨（lastOkAt）、部機最後收到（lastReceivedAt）、
 * endpointTail（endpoint 尾 12 字 — client 對比自己 pushManager 訂閱，標「呢部機」；完整 endpoint 唔回傳）。
 * vapidReady：server 有冇配置 Web Push。只回自己嘅 row（staffId = session）。
 */
export const dynamic = "force-dynamic";

function deviceLabel(ua: string | null): string {
  if (!ua) return "未知裝置";
  const os = /iPhone|iPod/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "其他";
  const br = /Edg\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung 瀏覽器"
      : /CriOS|Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox|FxiOS/.test(ua)
          ? "Firefox"
          : /Safari/.test(ua)
            ? "Safari"
            : "";
  return br ? `${os} · ${br}` : os;
}

export const GET = handle(async (req: NextRequest) => {
  const { staff, res } = await requireAuth(req);
  const cookie = res.headers.get("set-cookie") ?? "";
  const rows = await prisma.pushSubscription.findMany({
    where: { staffId: staff.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, endpoint: true, userAgent: true, createdAt: true, lastOkAt: true, lastReceivedAt: true },
  });
  const devices = rows.map((r) => ({
    id: r.id,
    label: deviceLabel(r.userAgent),
    endpointTail: r.endpoint.slice(-12),
    createdAt: r.createdAt.toISOString(),
    lastOkAt: r.lastOkAt?.toISOString() ?? null,
    lastReceivedAt: r.lastReceivedAt?.toISOString() ?? null,
  }));
  return Response.json({ vapidReady: vapidPublicKey() !== null, devices }, { headers: { "Set-Cookie": cookie } });
});
