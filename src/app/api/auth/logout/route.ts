import { type NextRequest } from "next/server";
import { destroySession, getSession } from "@/lib/session";
import { denySession } from "@/lib/rbac";
import prisma from "@/lib/prisma";
import log from "@/lib/log";

/**
 * POST /api/auth/logout — 清 session cookie + deny 呢個 session + 刪該機 push subscription。
 *
 * ★ cwi-final S3-2（A1）：登出只登出當前機 —
 *   1. denySession(sid)：只有呢個 session 失效（其他機嘅同帳號 session 照常用；
 *      denylist TTL = session 剩餘有效期；socket 由 control bridge `session:denied` 即時斷）。
 *   2. push subscription：client 帶 endpoint（呢部機嘅 subscription）→ 只刪 endpoint 匹配嘅 row；
 *      冇帶 → 唔刪（其他機照收 push）。
 *   （舊版 deleteSubscriptionsForStaff 全刪 = 共用前台機鐵律嘅 server 兜底 — A1 之後收窄到
 *    當前機；`push.ts` 嘅 deleteSubscriptionsForStaff 保留俾「停用帳號」用。）
 *
 * ★ 共用前台機鐵律（cwi-notify-v2-20260903 MD §3.6）仍然成立：client 登出時已自行
 *   pushManager.unsubscribe + POST /api/push/unsubscribe（client 層第一道）；呢度係 server 兜底。
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 登出前攞 session（此時仍然有效）
  const { data } = await getSession(req);
  const body = (await req.json().catch(() => null)) as { endpoint?: string } | null;
  if (data?.staffId) {
    await denySession(data);
    // ★ A1：只刪呢部機嘅 push subscription（client 帶 endpoint；冇帶就唔刪 — 其他機照收）
    if (body?.endpoint) {
      await prisma.pushSubscription
        .deleteMany({ where: { staffId: data.staffId, endpoint: body.endpoint } })
        .catch((err) =>
          log.warn({ staffId: data.staffId, err: err instanceof Error ? err.message : String(err) }, "logout: push subscription 刪除失敗（靜默）")
        );
    }
  }
  const res = await destroySession(req);
  log.info("logout: done");
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": res.headers.get("set-cookie") ?? "",
    },
  });
}
