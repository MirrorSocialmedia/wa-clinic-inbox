import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { WORKFLOW_KEYS, type WorkflowKey } from "@/lib/workflow/definitions";
import { saveDraft, WorkflowError } from "@/lib/workflow/store";

/**
 * PUT /api/admin/workflows/[key] — ADMIN-only：存草稿（zod 驗證；publish 前唔生效）。
 * body: { clinicId: string|null, params: object } → 201 { id, version }
 * 驗證失敗 → 400 + field-level issues（表單 inline 顯示）。
 */
export const dynamic = "force-dynamic";

const putSchema = z.object({
  clinicId: z.union([z.string().min(1), z.null()]),
  params: z.record(z.string(), z.unknown()),
});

export const PUT = handle(async (req: NextRequest, ctx) => {
  const auth = await requireAdmin(req);
  const { key } = (await ctx.params) as { key: string };
  if (!WORKFLOW_KEYS.includes(key as WorkflowKey)) {
    throw new WorkflowError(404, `unknown workflow key: ${key}`);
  }
  const body = putSchema.parse(await req.json());
  const { id, version } = await saveDraft(key as WorkflowKey, body.clinicId, body.params, auth.staff.id);
  return NextResponse.json({ id, version }, { status: 201 });
});
