import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { enqueueOutboundSend } from "@/lib/queue";
import { buildMessageNewPayload } from "@/lib/realtime-payload";
import { convRef, publishConvEvent } from "@/lib/notify";
import { BILLING_SERVICE } from "@/lib/wa/billing";

/**
 * ★ cwi-inbox-r3（2026-10-17，擁有人拍板）：病人退訂（opt-out 自動偵測）後回一句固定確認 — 唔經 AI。
 *
 * - 只喺 applyFollowupOptOut 真係「新」標記（changed=true）先發 — 重複講 STOP 唔會重覆回。
 * - 病人啱啱發訊息 → 24h 窗口必開（free-form text 合法）；proactive=false（係回覆 — 唔受 opt-out 攔截）。
 * - sentByStaffId=null → 對話串標「系統」；outbound.worker 照正常路徑發（Graph / mock）。
 * - fail-soft：任何失敗只 log（退訂本身已生效 — 確認句係 courtesy）。
 */
export const OPT_OUT_ACK_TEXT = "收到 🙏 我哋之後唔會再主動發訊息俾你。如果有需要，隨時喺呢度搵我哋就得。";

export async function sendOptOutAck(conversationId: string): Promise<string | null> {
  try {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return null;
    const now = new Date();
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "API",
        type: "text",
        body: OPT_OUT_ACK_TEXT,
        billingCategory: BILLING_SERVICE,
        status: "QUEUED",
        sentByStaffId: null,
        proactive: false,
        waTimestamp: now,
      },
    });
    await prisma.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;
    await publishConvEvent(convRef(conv), "message:new", await buildMessageNewPayload(msg.id));
    await enqueueOutboundSend(msg.id);
    await prisma.auditLog
      .create({
        data: {
          staffId: null,
          action: "OPT_OUT_ACK_SENT",
          entity: "Message",
          entityId: msg.id,
          meta: { conversationId: conv.id, clinicId: conv.clinicId } as object,
        },
      })
      .catch(() => undefined);
    return msg.id;
  } catch (err) {
    log.warn({ conversationId, err: err instanceof Error ? err.message : String(err) }, "opt-out ack: send failed（fail-soft — 退訂已生效）");
    return null;
  }
}
