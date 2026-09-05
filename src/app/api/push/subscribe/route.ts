import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import prisma from "@/lib/prisma";
import log from "@/lib/log";

/**
 * POST /api/push/subscribe — 存/更新 subscription（upsert by endpoint）綁登入 staff。
 * body: { endpoint: string, keys: { p256dh: string, auth: string }, userAgent?: string }
 *
 * endpoint 係 per-device/browser 唯一（push 標準）— 同一台瀏覽器登唔同一人時，
 * 登出 route 會先刪 row（共用前台機鐵律），所以唔需要 staff+endpoint 複合 unique。
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const { staff, res } = await requireAuth(req);
  const cookie = res.headers.get("set-cookie") ?? "";

  const body = (await req.json().catch(() => null)) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    userAgent?: string;
  } | null;

  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || !p256dh || !auth) {
    return Response.json({ error: "missing fields" }, { status: 400, headers: { "Set-Cookie": cookie } });
  }

  const userAgent = typeof body?.userAgent === "string" ? body.userAgent.slice(0, 300) : null;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { staffId: staff.id, endpoint, p256dh, auth, userAgent },
    update: {
      // endpoint 被另一 browser 重用 → 改綁新登入者（前台機換人场景兜底）
      staffId: staff.id,
      p256dh,
      auth,
      userAgent,
    },
  });
  log.info({ staffId: staff.id }, "push: subscription 已存/更新");
  return Response.json({ ok: true }, { status: 200, headers: { "Set-Cookie": cookie } });
});
