/**
 * POST /api/admin/ai-sandbox/reset — ★ cwi-hub-b-20260914（Part B B.5 [重新開始]）。
 *
 * { sandboxId } → 200（清 Redis key `sandbox:{staffId}:{sandboxId}`；
 * state 永不落 DB 所以冇 DB 殘留 — 重啟 = 乾淨）。
 * RBAC：ADMIN only。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, RbacError } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { resetSandbox } from "@/lib/ai/sandbox";

export const dynamic = "force-dynamic";

const resetSchema = z.object({
  sandboxId: z.string().min(1).max(64),
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = await req.json().catch(() => null);
  const p = resetSchema.safeParse(body);
  if (!p.success) throw new RbacError(400, p.error.issues[0]?.message ?? "invalid body");
  await resetSandbox(ctx.staff.id, p.data.sandboxId);
  return NextResponse.json({ ok: true });
});
