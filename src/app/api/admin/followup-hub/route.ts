/**
 * /api/admin/followup-hub — cwi-followup-p4-20260916 S6：hub 第二 tab「主動跟進」摘要。
 * GET → { rules[7], cancelConditions[6], sendPolicy, health[5], queue }
 * ADMIN / SUPERVISOR 可讀（同 /api/admin/ai 口徑）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdminOrSupervisor } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { buildFollowupHubSummary } from "@/lib/followup/hub-summary-p4";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAdminOrSupervisor(req);
  const summary = await buildFollowupHubSummary();
  return NextResponse.json(summary);
});
