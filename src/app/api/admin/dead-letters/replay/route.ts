import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import log from "@/lib/log";
import { replayUnreplayedDeadLetters } from "@/lib/ops/dead-letter";

/**
 * POST /api/admin/dead-letters/replay — 重放所有未重放 DLQ 行（global admin only）。
 *
 * ★ cwi-qa FX-21（QA-21）：requireAdmin → requireGlobalAdmin — replay 唔分 clinic scope，
 *   任何公司級 ADMIN 都可重放全部店嘅 DLQ（含其他公司）→ 必須 ALL scope。
 *
 * ★ cwi-final S1-1a：inbound job 最終失敗 → DeadLetter（AES-256-GCM 加密 payload）。
 * 重放 = decrypt → inboundQueue 重入（WebhookEvent claim 冪等 → 重放安全，訊息唔會重複入 DB）。
 * 冪等：失敗行留 replayedAt=null 俾下次再試；成功行標 replayedAt（唔會重放第二次）。
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const auth = await requireGlobalAdmin(req);

  const r = await replayUnreplayedDeadLetters();
  const pending = await prisma.deadLetter.count({ where: { replayedAt: null } });

  log.info({ byStaff: auth.staff.id, ...r, pending }, "admin: DLQ replay");
  return NextResponse.json({ ...r, pending });
});
