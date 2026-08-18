/**
 * 發 Booking Flow（staff 撳 📅 掣 → POST /api/conversations/[id]/flows → 呢度）
 *
 * 行為：
 * 1. 窗口檢查（24h — 過窗 → WindowClosedError → route 回 422 提示用 template）
 * 2. 冪等：已有 SENT FlowSession → 重用（唔重發訊息）
 * 3. 創 FlowSession(SENT) + flow_token（JWT 簽 conversationId+clinicId）
 * 4. Message(OUT, API, type=interactive, body=flow config JSON, QUEUED) + outboundQueue
 * 5. AuditLog(SEND_FLOW)
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { randomBytes } from "node:crypto";
import { outboundQueue } from "@/lib/queue";
import { getWindowState } from "@/lib/wa/window";
import { defaultFlowConfig } from "@/lib/wa/graph";
import { signFlowToken, flowJwtSecret } from "@/lib/flows/crypto";

export class WindowClosedError extends Error {
  constructor() {
    super("window_closed");
  }
}

const ENQUEUE_TIMEOUT_MS = 1500;

export interface SendFlowResult {
  flowToken: string;
  flowSessionId: string;
  messageId: string;
  /** true = 重用咗已有 SENT session（冇發新訊息） */
  reused: boolean;
}

export async function sendBookingFlow(opts: {
  conversationId: string;
  /** null = 系統自動（precheck 失敗重出 Flow） */
  staffId: string | null;
}): Promise<SendFlowResult> {
  const conv = await prisma.conversation.findUnique({ where: { id: opts.conversationId } });
  if (!conv) throw new Error("conversation not found");

  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) throw new WindowClosedError();

  // 冪等：已有流緊嘅 FlowSession → 重用（防 staff 連撳 / 重載重發）
  const existing = await prisma.flowSession.findFirst({
    where: { conversationId: conv.id, status: "SENT" },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    log.info({ conversationId: conv.id, flowSessionId: existing.id }, "flow send: reused active session");
    return {
      flowToken: existing.flowToken,
      flowSessionId: existing.id,
      messageId: existing.flowMessageWamid ?? "",
      reused: true,
    };
  }

  const token = signFlowToken(
    { convId: conv.id, clinicId: conv.clinicId, jti: randomBytes(8).toString("hex") },
    flowJwtSecret()
  );
  const session = await prisma.flowSession.create({
    data: {
      conversationId: conv.id,
      clinicId: conv.clinicId,
      flowToken: token,
      status: "SENT",
    },
  });

  const now = new Date();
  const msg = await prisma.message.create({
    data: {
      conversationId: conv.id,
      direction: "OUT",
      channel: "API",
      type: "interactive",
      body: JSON.stringify(defaultFlowConfig(token)),
      status: "QUEUED",
      sentByStaffId: opts.staffId,
      waTimestamp: now,
    },
  });

  await prisma.$executeRaw`
    UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;

  await prisma.auditLog
    .create({
      data: {
        staffId: opts.staffId,
        action: "SEND_FLOW",
        entity: "FlowSession",
        entityId: session.id,
        meta: { conversationId: conv.id, messageId: msg.id },
      },
    })
    .catch(() => undefined);

  try {
    await Promise.race([
      outboundQueue.add("send", { messageId: msg.id }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    await prisma.message
      .update({ where: { id: msg.id }, data: { status: "FAILED", errorCode: "ENQUEUE_FAILED" } })
      .catch(() => undefined);
    log.error({ messageId: msg.id, err: err instanceof Error ? err.message : String(err) }, "flow send: enqueue failed");
    throw err;
  }

  log.info(
    { conversationId: conv.id, clinicId: conv.clinicId, messageId: msg.id, staffId: opts.staffId },
    "flow send: queued interactive flow message"
  );
  return { flowToken: token, flowSessionId: session.id, messageId: msg.id, reused: false };
}
