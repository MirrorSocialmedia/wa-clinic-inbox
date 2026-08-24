import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { WORKFLOW_KEYS, type WorkflowKey } from "@/lib/workflow/definitions";
import { publish, WorkflowError } from "@/lib/workflow/store";

/**
 * POST /api/admin/workflows/[key]/publish — ADMIN-only：發佈草稿（唯一生效動作）。
 * body: { defId } → 200 { ok }。transaction：舊 ACTIVE → ARCHIVED；本 row → ACTIVE + AuditLog。
 */
export const dynamic = "force-dynamic";

const publishSchema = z.object({ defId: z.string().min(1) });

export const POST = handle(async (req: NextRequest, ctx) => {
  const auth = await requireAdmin(req);
  const { key } = (await ctx.params) as { key: string };
  if (!WORKFLOW_KEYS.includes(key as WorkflowKey)) {
    throw new WorkflowError(404, `unknown workflow key: ${key}`);
  }
  const body = publishSchema.parse(await req.json());
  await publish(body.defId, auth.staff.id);
  return NextResponse.json({ ok: true });
});
