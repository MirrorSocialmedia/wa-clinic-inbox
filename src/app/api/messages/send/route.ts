import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess, clinicScope } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { outboundQueue } from "@/lib/queue";
import { getWindowState } from "@/lib/wa/window";

/**
 * POST /api/messages/send — 員工發 free-form 訊息（框架 MD §6.3）。
 *
 * 1. RBAC：STAFF 只能發自己店嘅對話（assertClinicAccess → 403 實測）
 * 2. 窗口檢查：now - lastInboundAt < 24h 先准 free-form；
 *    過窗 → 422（UI 轉 template 選項 — template 發送 Phase 1 之後）
 * 3. 寫 Message(OUT, API, QUEUED) + AuditLog(SEND)
 * 4. outboundQueue.add → worker 負責真發送（mock mode 回假 wamid）
 *
 * ★ 過窗 template 發送：Phase 1 範圍外（template 管理頁未做）— 422 明確
 *   告知「只可發 template」。真機對接後補 POST /api/messages/send-template。
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  conversationId: z.string().min(1),
  body: z.string().min(1).max(4096), // WA text 上限 4096 chars
});

const ENQUEUE_TIMEOUT_MS = 1500;

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const conv = await prisma.conversation.findUnique({
    where: { id: parsed.data.conversationId },
  });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(ctx, conv.clinicId); // STAFF 砌別店 URL → 403

  // 窗口檢查（fail-closed：lastInboundAt = null → 過窗）
  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) {
    log.info(
      { clinicId: conv.clinicId, conversationId: conv.id, staffId: ctx.staff.id, remainingHours: Math.round(win.remainingHours * 10) / 10 },
      "send: window closed, free-form rejected"
    );
    return NextResponse.json(
      {
        error: "window_closed",
        message: "24 小時客服窗口已過，只可以發 template（utility）",
        remainingHours: 0,
      },
      { status: 422 }
    );
  }

  // clinicScope 佢都過一次（belt & braces：route 層嘅 fail-closed 驗證）
  void clinicScope(ctx);

  const now = new Date();
  const msg = await prisma.message.create({
    data: {
      conversationId: conv.id,
      direction: "OUT",
      channel: "API",
      type: "text",
      body: parsed.data.body,
      status: "QUEUED",
      sentByStaffId: ctx.staff.id,
      waTimestamp: now,
    },
  });

  await prisma.$executeRaw`
    UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;

  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "SEND",
        entity: "Message",
        entityId: msg.id,
      },
    })
    .catch(() => undefined);

  // Phase 2：AI draft 採用追蹤（採用率 + 微調數據）。
  // 查對話最新嘅 PROPOSED draft（ai.worker 已將 Message.aiDraftId 指向佢）：
  // - 發出內容同 draft 一字不差 → SENT_AS_IS；改過 → SENT_EDITED（finalText 留底）
  // ★ 失敗唔準影響發送（try/catch 吞掉）— draft 統計只係观测数据。
  try {
    const linkedMsg = await prisma.message.findFirst({
      where: { conversationId: conv.id, direction: "IN", aiDraftId: { not: null } },
      orderBy: { waTimestamp: "desc" },
      select: { aiDraftId: true },
    });
    if (linkedMsg?.aiDraftId) {
      const draft = await prisma.aiDraft.findUnique({ where: { id: linkedMsg.aiDraftId } });
      if (draft && draft.conversationId === conv.id && draft.status === "PROPOSED") {
        const asIs = parsed.data.body.trim() === draft.draftText.trim();
        await prisma.aiDraft.update({
          where: { id: draft.id },
          data: { status: asIs ? "SENT_AS_IS" : "SENT_EDITED", finalText: parsed.data.body },
        });
        await prisma.message.update({ where: { id: msg.id }, data: { aiDraftId: draft.id } });
        log.info(
          { clinicId: conv.clinicId, conversationId: conv.id, draftId: draft.id, messageId: msg.id, adopted: asIs },
          "send: ai draft linked (SENT_AS_IS/SENT_EDITED)"
        );
      }
    }
  } catch (err) {
    log.warn(
      { clinicId: conv.clinicId, conversationId: conv.id, err: err instanceof Error ? err.message : String(err) },
      "send: ai draft link failed (ignored, 不影響發送)"
    );
  }

  try {
    await Promise.race([
      outboundQueue.add("send", { messageId: msg.id }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    // queue fail：訊息留喺 DB（QUEUED）但冇 job — 標 FAILED 話知 UI，避免靜默
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: "FAILED", errorCode: "ENQUEUE_FAILED" },
    }).catch(() => undefined);
    log.error(
      { messageId: msg.id, err: err instanceof Error ? err.message : String(err) },
      "send: enqueue failed, message marked FAILED"
    );
    return NextResponse.json({ error: "queue unavailable" }, { status: 503 });
  }

  log.info(
    { clinicId: conv.clinicId, conversationId: conv.id, messageId: msg.id, staffId: ctx.staff.id, bodyLen: parsed.data.body.length },
    "send: queued"
  );
  return NextResponse.json({ ok: true, messageId: msg.id, status: "QUEUED" }, { status: 202 });
});
