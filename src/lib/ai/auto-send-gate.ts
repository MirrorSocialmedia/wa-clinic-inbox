/**
 * ★ cwi-final S4-2（audit3 P0-01 / P0-02 / P2-23 / P2-39；D-6）：自動發送原子閘。
 *
 * 所有「冇人撳掣」嘅病人訊息 auto-send 路徑必經 `sendAutoIfStillEligible`：
 * FOR UPDATE 鎖 Conversation → 重查所有 gate（level / already-answered / 人手接手 /
 * send lock 等）→ 建 Message(QUEUED, aiAutoSent=true, replyToMessageId=triggerMsgId)
 * → 草稿轉態 → audit，**全部同一 tx**（R-18：plain updateMany 擋唔到員工同一刻接手）。
 *
 * P0-02：每條 inbound 只可被 AI 自動覆一次（partial unique index Message_ai_reply_once —
 * concurrent 競態第二個 tx INSERT 撞 P2002 → duplicate-reply，只成一件）。
 * D-6：gate 放棄時唔改草稿狀態（草稿留 PROPOSED，由 S1-13 堆疊顯示 stale）。
 *
 * enqueue 由 caller 喺 commit 之後做；enqueue 唔確定 → 留 QUEUED（S1-15 sweeper 補發）。
 *
 * ★ PII：audit meta 只 id + category（零訊息原文）。
 */
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getWindowState } from "@/lib/wa/window";
import { getAutomationLevel, type AutomationLevel } from "@/lib/ai/automation";

const RANK: Record<AutomationLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

export type AutoSendSource = "AI_DRAFT" | "BOOKING_SESSION" | "PAIN_SESSION" | "L4_CONFIRM";

export interface AutoSendRequest {
  convId: string;
  clinicId: string;
  triggerMsgId: string;
  /** level 解析用嘅類別；PAIN_SESSION 用 painTriageEnabled()（S4-3），唔經呢度 */
  levelCategory: string;
  minLevel: AutomationLevel;
  text: string;
  source: AutoSendSource;
  draftId?: string | null;
  bookingSessionId?: string | null;
  billingCategory?: string;
  /** PAIN_SESSION 由 caller 預先判斷 enabled；true = 跳過 level 檢查 */
  levelPrechecked?: boolean;
}

export type AutoSendResult = { sent: true; messageId: string } | { sent: false; reason: string };

/**
 * ★ cwi-final S4-2：所有「冇人撳掣」嘅病人訊息必經呢度。
 * FOR UPDATE 鎖 Conversation → 重查所有 gate → 建 Message(QUEUED) → 草稿轉態 → audit，全部同一 tx。
 * enqueue 由 caller 喺 commit 之後做；enqueue 唔確定 → 留 QUEUED（S1-15 sweeper 補發）。
 */
export async function sendAutoIfStillEligible(req: AutoSendRequest): Promise<AutoSendResult> {
  if (!req.levelPrechecked) {
    const level = await getAutomationLevel(req.clinicId, req.levelCategory); // 已含 AI_GLOBAL_MAX_LEVEL
    if (RANK[level] < RANK[req.minLevel]) return { sent: false, reason: `level-${level}` };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ assigneeId: string | null; status: string; urgent: boolean; humanTookOver: boolean; lastInboundAt: Date | null }[]>`
        SELECT "assigneeId", "status", "urgent", "humanTookOver", "lastInboundAt"
        FROM "Conversation" WHERE "id" = ${req.convId} FOR UPDATE`;
      const c = rows[0];
      if (!c) return { sent: false, reason: "conv-missing" } as const;
      if (c.assigneeId !== null) return { sent: false, reason: "assigned" } as const;
      if (c.humanTookOver) return { sent: false, reason: "human-took-over" } as const;
      if (c.status === "RESOLVED") return { sent: false, reason: "resolved" } as const;
      if (c.urgent) return { sent: false, reason: "conv-urgent" } as const;
      if (!getWindowState(c.lastInboundAt).open) return { sent: false, reason: "window-closed" } as const;

      const trigger = await tx.message.findUnique({ where: { id: req.triggerMsgId }, select: { id: true, createdAt: true } });
      if (!trigger) return { sent: false, reason: "trigger-missing" } as const;

      // P0-02：有較新病人訊息 → 呢個 job 已過時（較新嗰個 job 會用完整 context 覆）
      const newerIn = await tx.message.findFirst({
        where: {
          conversationId: req.convId, direction: "IN", channel: "API",
          OR: [{ createdAt: { gt: trigger.createdAt } }, { createdAt: trigger.createdAt, id: { gt: trigger.id } }],
        },
        select: { id: true },
      });
      if (newerIn) return { sent: false, reason: "superseded" } as const;

      // 觸發訊息之後已經有人（系統員工／★ A2 手機 App／其他自動覆）覆咗 → 唔再自動覆，草稿留俾員工
      const answered = await tx.message.findFirst({
        where: {
          conversationId: req.convId, direction: "OUT",
          channel: { in: ["API", "APP_ECHO"] },
          createdAt: { gt: trigger.createdAt },
          status: { notIn: ["FAILED", "CANCELLED"] },
        },
        select: { id: true },
      });
      if (answered) return { sent: false, reason: "already-answered" } as const;

      if (req.draftId) {
        // ★ D-6：自動發只可以用「回覆觸發訊息」嗰個草稿（= 最新）；堆疊入面嘅舊草稿永遠唔自動發
        const upd = await tx.aiDraft.updateMany({ where: { id: req.draftId, status: "PROPOSED", inReplyToMessageId: req.triggerMsgId }, data: { status: "SENT_AUTO", finalText: req.text } });
        if (upd.count !== 1) return { sent: false, reason: "draft-not-proposed" } as const; // P2-23：staff 丟棄咗嘅唔發
      }

      const now = new Date();
      const msg = await tx.message.create({
        data: {
          conversationId: req.convId, direction: "OUT", channel: "API", type: "text",
          body: req.text, status: "QUEUED", sentByStaffId: null,
          aiAutoSent: true, sentVia: "AI_AUTO",
          aiDraftId: req.draftId ?? null,
          bookingSessionId: req.bookingSessionId ?? null,
          replyToMessageId: req.triggerMsgId,
          billingCategory: req.billingCategory ?? "SERVICE",
          waTimestamp: now,
        },
      });
      await tx.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}), "lastOutboundText" = ${req.text} WHERE "id" = ${req.convId}`;
      await tx.auditLog.create({
        data: {
          staffId: null,
          action: req.source === "AI_DRAFT" ? "AI_AUTO_SEND" : `AI_${req.source}_REPLY`,
          entity: "Message", entityId: msg.id,
          meta: { conversationId: req.convId, triggerMsgId: req.triggerMsgId, draftId: req.draftId ?? null, category: req.levelCategory } as Prisma.InputJsonValue,
        },
      });
      return { sent: true, messageId: msg.id } as const;
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return { sent: false, reason: "duplicate-reply" };
    throw e;
  }
}
