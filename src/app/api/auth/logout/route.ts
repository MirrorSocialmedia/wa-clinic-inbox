import { type NextRequest, NextResponse } from "next/server";
import { destroySession, getSession } from "@/lib/session";
import { deleteSubscriptionsForStaff } from "@/lib/push";
import log from "@/lib/log";

/**
 * POST /api/auth/logout — 清 session cookie + 刪該 staff 全部 Web Push subscription。
 *
 * ★ 共用前台機鐵律（cwi-notify-v2-20260903 MD §3.6）：client 登出時已自行
 *   pushManager.unsubscribe + POST /api/push/unsubscribe；呢度係 server 兜底 —
 *   防 client 清理失敗/被繞過（換人登入仲收到上一個人嘅通知 = 私隱事故）。
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 登出前攞 staffId（session 此時仍然有效）
  const { data } = await getSession(req);
  const res = await destroySession(req);
  if (data?.staffId) {
    // ★ 必 await：登入出後 row 未刪 = 換人登入仲收到上一個人嘅通知（MD §3.6 私隱鐵律）。
    // fire-and-forget 會同下一次登入 race — 共用前台機場景會出事故。
    await deleteSubscriptionsForStaff(data.staffId);
  }
  log.info("logout: done");
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": res.headers.get("set-cookie") ?? "",
    },
  });
}
