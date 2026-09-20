/**
 * ★ cwi-final S1-7：`message:new` 完整 payload 單一來源（由 inbound.worker notifyNewMessage 抽出）。
 *
 * 所有 message:new emitter（inbound / outbound / booking reminder / followup）一律經
 * `buildMessageNewPayload(messageId)` 發完整 payload — client handler 依此契約（S1-7）：
 *   - 有 message.id → 直接 append/patch 訊息
 *   - 冇 message（defensive）→ reconcileConversationRow 重拉
 *
 * 點解入 DB 重查而唔係傳現成 row：emitter 各自 hold 唔同時刻快照（outbound 攞 waMessageId
 * 之後嘅 row、reminder 攞 QUEUED row）— 統一由 messageId 拉最新 committed row，shape 先保證一致。
 *
 * PII 邊界：body = chat 內容（staff/病人都要見到嘅正常業務數據）；contact 只帶
 * waId/profileName/labels（同現行 socket 推一致）。
 */
import prisma from "@/lib/prisma";

/** ★ extends Record<string, unknown>：可直傳 publishConvEvent（spec 簽名 Record<string, unknown>） */
export interface MessageNewPayload extends Record<string, unknown> {
  conversationId: string;
  clinicId: string;
  contact: {
    id: string;
    waId: string;
    profileName: string | null;
    labels: string[];
  } | null;
  message: {
    id: string;
    conversationId: string;
    waMessageId: string | null;
    direction: string;
    channel: string;
    type: string;
    body: string | null;
    mediaPath: string | null;
    mediaStatus: string;
    clientMessageId: string | null;
    status: string;
    errorCode: string | null;
    sentByStaffId: string | null;
    // Phase 2b：UI「AI 自動覆」標記（outbound 訊息有；inbound 永遠 false）
    aiAutoSent: boolean;
    waTimestamp: Date;
    createdAt: Date;
  };
  conversation: {
    status: string;
    unreadCount: number;
    lastMessageAt: Date | null;
    lastInboundAt: Date | null;
    reopenedAt: Date | null;
  };
}

export async function buildMessageNewPayload(messageId: string): Promise<MessageNewPayload> {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg) throw new Error(`buildMessageNewPayload: message not found: ${messageId}`);
  const conv = await prisma.conversation.findUnique({
    where: { id: msg.conversationId },
    select: {
      contactId: true,
      clinicId: true,
      status: true,
      unreadCount: true,
      lastMessageAt: true,
      lastInboundAt: true,
      reopenedAt: true,
    },
  });
  if (!conv) throw new Error(`buildMessageNewPayload: conversation not found: ${msg.conversationId}`);
  const contact = conv.contactId
    ? await prisma.contact.findUnique({ where: { id: conv.contactId } })
    : null;
  return {
    conversationId: msg.conversationId,
    clinicId: conv.clinicId,
    contact: contact
      ? { id: contact.id, waId: contact.waId, profileName: contact.profileName, labels: contact.labels }
      : null,
    message: {
      id: msg.id,
      conversationId: msg.conversationId,
      waMessageId: msg.waMessageId,
      direction: msg.direction,
      channel: msg.channel,
      type: msg.type,
      body: msg.body,
      mediaPath: msg.mediaPath,
      mediaStatus: msg.mediaStatus,
      clientMessageId: msg.clientMessageId,
      status: msg.status,
      errorCode: msg.errorCode,
      sentByStaffId: msg.sentByStaffId,
      aiAutoSent: msg.aiAutoSent,
      waTimestamp: msg.waTimestamp,
      createdAt: msg.createdAt,
    },
    conversation: {
      status: conv.status,
      unreadCount: conv.unreadCount,
      lastMessageAt: conv.lastMessageAt,
      lastInboundAt: conv.lastInboundAt,
      reopenedAt: conv.reopenedAt,
    },
  };
}
