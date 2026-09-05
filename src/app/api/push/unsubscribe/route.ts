import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import prisma from "@/lib/prisma";
import log from "@/lib/log";

/**
 * POST /api/push/unsubscribe — 刪 endpoint（client 登出時先自行 unsubscribe 再呼叫）。
 * body: { endpoint: string }
 *
 * 只刪「屬於自己」嘅 endpoint（防他人 endpoint 被誤刪）— 共用前台機鐵律嘅
 * server 兜底層；登出 route 會全刪該 staff 剩低 row。
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const { staff, res } = await requireAuth(req);
  const cookie = res.headers.get("set-cookie") ?? "";

  const body = (await req.json().catch(() => null)) as { endpoint?: string } | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";

  let deleted = 0;
  if (endpoint) {
    const r = await prisma.pushSubscription.deleteMany({ where: { endpoint, staffId: staff.id } });
    deleted = r.count;
    if (r.count > 0) log.info({ staffId: staff.id, count: r.count }, "push: unsubscribe 已刪");
  }
  return Response.json({ ok: true, deleted }, { status: 200, headers: { "Set-Cookie": cookie } });
});
