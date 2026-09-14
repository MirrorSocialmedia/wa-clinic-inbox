/**
 * GET /api/admin/ai/keywords/impact?term= — ★ cwi-hub-b-20260914（Part B B.4）：
 * 改/刪口語表前嘅交叉影響（彈層數據源）— 受影響 routing rules / knowledge docs / 紅旗 / 觸發 FLOOR。
 * RBAC：ADMIN / SUPERVISOR 唯讀。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdminOrSupervisor } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { buildKeywordImpact } from "@/lib/ai/keyword-cross";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdminOrSupervisor(req);
  const term = req.nextUrl.searchParams.get("term");
  if (!term || !term.trim()) return NextResponse.json({ error: "term required" }, { status: 400 });
  const impact = await buildKeywordImpact(ctx, term);
  return NextResponse.json(impact);
});
