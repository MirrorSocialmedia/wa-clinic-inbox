/**
 * ★ Part F（cwi-raggolden-20260904，F.5）：inbox「加入測試集」彈窗預填。
 *
 * GET /api/golden-cases/prefill?messageId=<id> — server-side deid（profileName；Contact
 * 目前只存 profileName）+ AI 當時判斷（AiDraft intent 快照 → conversation.intent/urgency
 * fallback）+ expectDocIds（traceJson.knowledge.picked）。
 *
 * 權限：requireAuth + assertConversationAccess（STAFF 限綁定店/負責人對話）。
 * 零 PII：回傳嘅 utterance/contextBefore 已 deid — 彈窗顯示嘅就係會入庫嘅文字。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import prisma from "@/lib/prisma";
import { deid, deidList } from "@/lib/golden/deid";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const messageId = req.nextUrl.searchParams.get("messageId");
  if (!messageId) return NextResponse.json({ error: "messageId required" }, { status: 400 });
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg) return NextResponse.json({ error: "not found" }, { status: 404 });
  const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(ctx, { clinicId: conv.clinicId, assigneeId: conv.assigneeId });
  if (msg.direction !== "IN" || !msg.body) {
    return NextResponse.json({ error: "only IN text messages can be added" }, { status: 400 });
  }
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  // 之前 0–2 句（IN 病人句 — contextBefore 語義 = 病人前情）
  const prior = await prisma.message.findMany({
    where: {
      conversationId: msg.conversationId,
      id: { not: msg.id },
      waTimestamp: { lt: msg.waTimestamp },
    },
    orderBy: { waTimestamp: "desc" },
    take: 4,
    select: { direction: true, body: true },
  });
  const priorIn = prior
    .filter((m) => m.direction === "IN" && m.body)
    .slice(0, 2)
    .reverse()
    .map((m) => m.body);
  const draft = msg.aiDraftId ? await prisma.aiDraft.findUnique({ where: { id: msg.aiDraftId } }) : null;
  // AI 當時判斷：draft intent 快照優先；urgency/needsHuman 由 conversation（鐵律 intent 推斷）
  const intent = draft?.intent ?? (conv.intent as string | null) ?? "OTHER";
  const urgency = (conv.urgency as string | null) ?? "LOW";
  const needsHuman = intent === "URGENT_PAIN" || intent === "COMPLAINT" || urgency === "HIGH";
  const trace = (draft?.traceJson ?? null) as { knowledge?: { picked?: { id: string }[] } } | null;
  const names = [contact?.profileName].filter((n): n is string => typeof n === "string" && n.length > 0);
  return NextResponse.json({
    clinicId: conv.clinicId,
    utterance: deid(msg.body, names),
    contextBefore: deidList(priorIn, names),
    aiJudgment: { intent, needsHuman, urgency },
    expectDocIds: trace?.knowledge?.picked?.map((p) => p.id) ?? [],
    hasDraft: draft !== null,
  });
});
