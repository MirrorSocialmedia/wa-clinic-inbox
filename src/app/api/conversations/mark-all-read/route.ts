import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import { markAllRead } from "./handler-core";

/**
 * /api/conversations/mark-all-read — 一鍵已讀（cwi-ux UX-01）。
 *
 * ★ cwi-qa FX-16：route module 只准 route field 導出（unknown named export = build 硬紅）—
 *   handler core 喺 ./handler-core（unit test 直調，唔經 HTTP）。
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const body = (await req.json().catch(() => null)) as unknown;
  return markAllRead(ctx, body);
});
