/**
 * POST /api/admin/ai-sandbox/run — ★ cwi-hub-b-20260914（Part B B.3）：AI 流程沙盤。
 *
 * { clinicId, message, sandboxId? }
 *   → { sandboxId, turn, steps[7], draft, draftMode, intent, urgency, needsHuman,
 *       consultTrigger, sessionSnapshot, sendVerdict, latencyMs, llmCalls }
 * 鐵律（B.3.1）：真 pipeline 同款 function、零副作用（零 DB 寫 / 零 socket / 零 push / 零發送）。
 * - 400 message 空/太長；403 clinic 唔喺 scope；404 clinic 唔存在
 * - 502 AI 服務唔通（state 原封）；503 Redis 斷
 *
 * RBAC：ADMIN only（沙盤行真 LLM — SUPERVISOR 唯讀唔入）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, scopedClinicSet, RbacError } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { runSandboxTurn } from "@/lib/ai/sandbox";

export const dynamic = "force-dynamic";

const runSchema = z.object({
  clinicId: z.string().min(1).max(64),
  message: z.string().min(1).max(4000),
  sandboxId: z.string().min(1).max(64).optional(),
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = await req.json().catch(() => null);
  const p = runSchema.safeParse(body);
  if (!p.success) throw new RbacError(400, p.error.issues[0]?.message ?? "invalid body");
  const scope = scopedClinicSet(ctx);
  if (scope && !scope.includes(p.data.clinicId)) throw new RbacError(403, "clinic 唔喺你嘅 scope 內");
  const result = await runSandboxTurn({
    staffId: ctx.staff.id,
    clinicId: p.data.clinicId,
    message: p.data.message,
    sandboxId: p.data.sandboxId,
  });
  return NextResponse.json(result);
});
