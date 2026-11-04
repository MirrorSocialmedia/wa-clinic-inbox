/**
 * ★ cwi-workgroup-20261104：GET /api/workgroups/unread — 導航 badge（未讀總數 + @ 數；封存群唔計）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { unreadTotals } from "@/lib/workgroups";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  return NextResponse.json(await unreadTotals(auth.staff.id));
});
