import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, assertConfigScope } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { WORKFLOW_KEYS, type WorkflowKey } from "@/lib/workflow/definitions";
import { revert, WorkflowError } from "@/lib/workflow/store";

/**
 * POST /api/admin/workflows/[key]/revert — ADMIN-only：回退 = re-publish as v(n+1)（歷史唔改寫）。
 * body: { clinicId: string|null, toVersion: int } → 200 { id, newVersion }
 */
export const dynamic = "force-dynamic";

const revertSchema = z.object({
  clinicId: z.union([z.string().min(1), z.null()]),
  toVersion: z.number().int().min(1),
});

export const POST = handle(async (req: NextRequest, ctx) => {
  const auth = await requireAdmin(req);
  const { key } = (await ctx.params) as { key: string };
  if (!WORKFLOW_KEYS.includes(key as WorkflowKey)) {
    throw new WorkflowError(404, `unknown workflow key: ${key}`);
  }
  const body = revertSchema.parse(await req.json());
  // ★ cwi-final S3-1：回退目標店域必喺 scope 內（null 全局 → global admin only）
  assertConfigScope(auth, body.clinicId);
  const { id, newVersion } = await revert(key as WorkflowKey, body.clinicId, body.toVersion, auth.staff.id);
  return NextResponse.json({ id, newVersion });
});
