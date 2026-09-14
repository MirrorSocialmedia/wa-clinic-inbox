/**
 * /api/admin/ai — ★ cwi-hub-b-20260914（Part B B.2）：AI 流程 hub 摘要。
 *
 * GET → { steps[7]（序號/名/摘要/警示/anchor/detail）, health[6], swVersion, demoQuestions, clinics }
 * - 摘要每次載入即時算（buildHubSummary 零 cache — T360 斷言口徑：同 DB 一致）
 * - ADMIN / SUPERVISOR 可讀（SUPERVISOR = 全店唯讀語義沿用 Part A）
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdminOrSupervisor } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { buildHubSummary } from "@/lib/ai/hub-summary";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdminOrSupervisor(req);
  const summary = await buildHubSummary(ctx);
  return NextResponse.json(summary);
});
