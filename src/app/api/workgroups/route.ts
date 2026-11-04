/**
 * ★ cwi-workgroup-20261104：GET /api/workgroups — 我係成員嘅工作群（未讀 / @ 未讀 / 最後一句）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { myGroups } from "@/lib/workgroups";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  return NextResponse.json({ groups: await myGroups(auth.staff.id) });
});
