/**
 * ★ cwi-workgroup-p2-20261105：GET /api/workgroups/[id]/search?q= — 搵群入面訊息（內文／檔名；最新 30 條）。只限成員。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hit } from "@/lib/rate-limit";
import { searchGroupMessages } from "@/lib/workgroups";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  if (!(await hit(`wg:search:${auth.staff.id}`, 60, 60))) return NextResponse.json({ error: "rate_limited", message: "搵得太快，等一陣再試" }, { status: 429 });
  try {
    return NextResponse.json({ messages: await searchGroupMessages(id, auth, req.nextUrl.searchParams.get("q") ?? "") });
  } catch (e) {
    return wgError(e);
  }
});
