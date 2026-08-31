/**
 * POST /api/conversations/[id]/flag — 標記投訴 / AI 錯誤（Phase E 即時記帳，cwi-ai-20260825-t5）。
 *
 * 前線先見到問題 — STAFF 可用（assertConversationAccess 守店界）。
 * - body: { kind: "COMPLAINT" | "AI_ERROR" }
 * - AuditLog(MARK_COMPLAINT / MARK_AI_ERROR, meta: { intent })
 * - AutomationStat(complaints++) — AI_ERROR 都計入 complaints（同一「唔收貨」訊號，唔另開欄）
 * - 冪等：同 conversation 同 kind 24h 內重複 flag → 200 no-op（唔重計）
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { bumpStat } from "@/lib/ops/automation-stats";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ kind: z.enum(["COMPLAINT", "AI_ERROR"]) });
const DEDUP_MS = 24 * 3_600_000;

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(ctx, conv); // STAFF 別店 → 403

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request", message: "kind 必須係 COMPLAINT 或 AI_ERROR" }, { status: 400 });
  }
  const kind = parsed.data.kind;
  const action = kind === "COMPLAINT" ? "MARK_COMPLAINT" : "MARK_AI_ERROR";

  // 冪等：同對話同 kind 24h 內已 flag 過 → no-op（AuditLog 查重）
  const dup = await prisma.auditLog.findFirst({
    where: { action, entity: "Conversation", entityId: conv.id, createdAt: { gte: new Date(Date.now() - DEDUP_MS) } },
    select: { id: true },
  });
  if (dup) {
    log.info({ conversationId: conv.id, kind, staffId: ctx.staff.id }, "conversations: flag 24h 內重複 → no-op");
    return NextResponse.json({ ok: true, counted: false });
  }

  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action,
      entity: "Conversation",
      entityId: conv.id,
      meta: { intent: conv.intent, clinicId: conv.clinicId } as object,
    },
  });
  await bumpStat(conv.clinicId, conv.intent ?? "UNKNOWN", "complaints");

  log.info(
    { conversationId: conv.id, clinicId: conv.clinicId, kind, intent: conv.intent, staffId: ctx.staff.id },
    "conversations: flagged（complaints+1）"
  );
  return NextResponse.json({ ok: true, counted: true });
});
