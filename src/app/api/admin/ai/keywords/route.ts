/**
 * GET /api/admin/ai/keywords?q= — ★ cwi-hub-b-20260914（Part B B.4）：關鍵詞中心交叉 view。
 * 四來源（lexicon / FLOOR+附加觸發詞 / RoutingRule.keywords / KnowledgeDoc.keywords 唯讀）
 * 一詞一行 + 邊幾層用緊。搜尋 = 單詞版沙盤。
 * RBAC：ADMIN / SUPERVISOR 唯讀。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdminOrSupervisor } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { buildKeywordView } from "@/lib/ai/keyword-cross";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdminOrSupervisor(req);
  const q = req.nextUrl.searchParams.get("q");
  const view = await buildKeywordView(ctx, q);
  return NextResponse.json(view);
});
