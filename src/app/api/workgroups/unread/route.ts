/**
 * ★ cwi-workgroup-20261104：GET /api/workgroups/unread — 導航 badge（未讀總數 + @ 數；封存群唔計）。
 * ★ p2：external = 有未讀嘅外部對話數（Lab／供應商）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { unreadTotals } from "@/lib/workgroups";
import { externalUnreadCount } from "@/lib/external-contacts";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  const [t, external] = await Promise.all([unreadTotals(auth.staff.id), externalUnreadCount(auth)]);
  return NextResponse.json({ ...t, external });
});
