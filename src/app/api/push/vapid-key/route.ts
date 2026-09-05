import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import { vapidPublicKey } from "@/lib/push";

/**
 * GET /api/push/vapid-key — VAPID public key（client pushManager.subscribe 用）。
 * public key 唔係 secret，但要登入先畀（避免未認證客戶端探测服務狀態）。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const { res } = await requireAuth(req);
  const cookie = res.headers.get("set-cookie") ?? "";
  const publicKey = vapidPublicKey();
  if (!publicKey) {
    return Response.json({ error: "push not configured" }, { status: 503, headers: { "Set-Cookie": cookie } });
  }
  return Response.json({ publicKey }, { status: 200, headers: { "Set-Cookie": cookie } });
});
