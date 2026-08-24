import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { WORKFLOW_KEYS, type WorkflowKey } from "@/lib/workflow/definitions";
import { listVersions, WorkflowError } from "@/lib/workflow/store";

/**
 * GET /api/admin/workflows/[key]/versions?clinicId= — ADMIN-only：版本列（DESC）。
 * 每 row：version/status/createdBy/publishedAt/createdAt/params。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest, ctx) => {
  await requireAdmin(req);
  const { key } = (await ctx.params) as { key: string };
  if (!WORKFLOW_KEYS.includes(key as WorkflowKey)) {
    throw new WorkflowError(404, `unknown workflow key: ${key}`);
  }
  const clinicId = req.nextUrl.searchParams.get("clinicId");
  const versions = await listVersions(key as WorkflowKey, clinicId ?? null);
  return NextResponse.json({ versions });
});
