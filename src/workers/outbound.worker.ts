import { Worker, type Job } from "bullmq";
import { outboundQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import { OUTBOUND_CONCURRENCY } from "./concurrency";
import { publishConvEvent, convRef } from "@/lib/notify";
import { buildMessageNewPayload } from "@/lib/realtime-payload";
import { sendTextMessage, sendFlowMessage, sendTemplateMessage, isPermanentGraphError, type FlowMessageConfig, type TemplateComponent } from "@/lib/wa/graph";
// ★ cwi-final S1-1c：waMessageId 寫入後 drain 早過訊息嘅 status（PendingStatus）
import { drainPendingStatuses } from "@/lib/wa/status-apply";
import { acquireToken } from "@/lib/rate-limit";
// ★ cwi-final S1-15：outbound_unknown（HIGH，唔喺 HEALTH_OWNED_TYPES — 唔會自動 resolve）
import { upsertAlert } from "@/lib/health/alerts";
import prisma from "@/lib/prisma";
import log from "@/lib/log";

/**
 * outbound worker — 發訊息 + 重試 + status 回寫（框架 MD §6.3）
 *
 * job.data = { messageId }（Message(OUT, API, QUEUED) 已由 API route 寫好）
 *
 * 流程：
 * 1. 讀 Message + Conversation + Contact + Clinic（攞 waDisplayNumber? 唔 — 攞 waPhoneNumberId + contact.waId）
 * 2. atomic claim：QUEUED + waMessageId null → SENDING（claim miss + SENDING 無 wamid = 上次 attempt 死咗 mid-call → UNKNOWN）
 * 3. per-number token bucket（80 msg/s 保險）
 * 4. graph.sendTextMessage（mock mode 回假 wamid）
 * 5. 成功 → 條件寫 waMessageId + SENT（只喺仍 SENDING 時；否則補 wamid）→ drain PendingStatus → Socket 推 message:new
 * 6. 失敗：transient → 返 QUEUED 重試；timeout（TimeoutError）→ UNKNOWN 唔重試；final → FAILED + StaffNotice
 * 7. 最終失敗（permanent）→ FAILED + UnrecoverableError（job 下次 attempt 會 claim-miss skip）
 *
 * ★ 冪等（S1-15 claim 取代舊 guard）：job 重試時 Message 可能已經有 waMessageId / 已過 QUEUED
 *   → claim 失敗 → skip（UNKNOWN 唔會再 claim → 禁自動重發，防雙發）。
 *
 * ★ PII 鐵律：log 只帶 messageId / wamid / phone_number_id / status，內文永不入 log。
 */

export interface OutboundJobData {
  messageId: string;
}

/** ★ cwi-final S1-15：permanent Graph 錯誤嘅最終失敗 — throw 俾 queue 記錄 failed；
 *  下次 attempt 會 claim-miss skip（status 已 FAILED）→ 唔會雙發。export 畀 S4-2 media 段同用。 */
export class UnrecoverableError extends Error {}

async function processOutboundJob(job: Job<OutboundJobData>): Promise<void> {
  const { messageId } = job.data;

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg) {
    log.warn({ messageId }, "outbound: message not found (already cleaned?), skipping");
    return;
  }
  // ★ cwi-final S1-15 (P0-07)：取代舊冪等 guard — atomic claim（QUEUED + waMessageId null → SENDING）。
  //   claim miss + SENDING 無 wamid = 上次 attempt 死咗 mid-Graph-call → 結果未知 →
  //   UNKNOWN + HIGH alert + UI 事件（禁自動重發 — 防雙發；人手核對）。
  const claim = await prisma.message.updateMany({
    where: { id: messageId, status: "QUEUED", waMessageId: null },
    data: { status: "SENDING" },
  });
  if (claim.count === 0) {
    const cur = await prisma.message.findUnique({
      where: { id: messageId },
      select: { status: true, waMessageId: true, conversationId: true },
    });
    if (cur?.status === "SENDING" && !cur.waMessageId) {
      await markOutboundUnknown(messageId, cur.conversationId, cur.waMessageId);
    }
    log.info({ messageId, status: cur?.status }, "outbound: not claimable — skip");
    return;
  }
  // ★ cwi-inboxfix-20260905（MD §5.2）：CANCELLED 双保險 guard —
  //   cwi-notify-fix-20260907（§7 撤回作廢）後 undo route 已刪、CANCELLED 唔會再產生；
  //   此 guard 保留做 legacy 在途 job（部署前 enqueue）/ 殘留 CANCELLED row 嘅兜底，
  //   成本 ~0（一個 status 比較）→ 保留唔刪。（S1-15 後 CANCELLED 亦會被上面 claim miss 攔到 — 此處多一道）
  if (msg.status === "CANCELLED") {
    log.info({ messageId }, "outbound: message CANCELLED (legacy) — skip send");
    return;
  }

  const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
  if (!conv) {
    throw new Error(`outbound: conversation missing for message ${messageId}`);
  }
  const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId } });
  if (!clinic) {
    throw new Error(`outbound: clinic missing for conversation ${conv.id}`);
  }
  const contactRow = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  if (!contactRow) {
    throw new Error(`outbound: contact missing for conversation ${conv.id}`);
  }

  // cwi-window-20260901（P4 / W-3）：單訊息鐵律觀察點 — 5s burst guard（唔擋，先觀察）。
  // AI 自動覆拆咗多條（同對話 5s 內第 2 條 aiAutoSent OUT）= prompt 鐵律被違反 → log warn 計數，
  // 累積多先決定加硬擋。PII：只帶 id metadata，內文永不入 log。
  if (msg.aiAutoSent && msg.direction === "OUT") {
    const since = new Date(Date.now() - 5_000);
    const priorAutoOut = await prisma.message.count({
      where: {
        conversationId: conv.id,
        direction: "OUT",
        aiAutoSent: true,
        createdAt: { gte: since },
        id: { not: msg.id },
      },
    });
    if (priorAutoOut > 0) {
      log.warn(
        { messageId, conversationId: conv.id, clinicId: clinic.id, windowSec: 5, priorAutoOut },
        "outbound: multi-message burst"
      );
    }
  }

  // 1) rate limit（per phone_number_id, 80 msg/s）
  await acquireToken({ key: clinic.waPhoneNumberId });

  // 2) 發送
  const body = msg.body;
  if (!body) {
    // 空 body 嘅 OUT API message = 壞數據（API route 已擋）→ 標 FAILED 唔重試
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: "FAILED", errorCode: "EMPTY_BODY" },
    });
    // ★ cwi-final S1-4：conv room 事件轉 publishConvEvent（clinic room + 跨店目標）— conv 有齊五欄
    await publishConvEvent(convRef(conv), "message:status", {
      conversationId: conv.id,
      clinicId: clinic.id,
      waMessageId: msg.waMessageId ?? msg.id,
      status: "FAILED",
      errorCode: "EMPTY_BODY",
    });
    return;
  }

  const isFlow = msg.type === "interactive";
  const isTemplate = msg.type === "template";
  const maxAttempts = job.opts.attempts ?? 3;
  try {
    let wamid: string;
    if (isFlow) {
      // Phase 3：interactive flow message（body = flow config JSON — 無病人內容）
      const flowCfg = JSON.parse(body) as FlowMessageConfig;
      if (!flowCfg.flow_token || !flowCfg.flow_cdn_url || !flowCfg.flow_id) {
        throw new Error("BAD_FLOW_CONFIG");
      }
      const r = await sendFlowMessage({
        phoneNumberId: clinic.waPhoneNumberId,
        to: contactRow.waId,
        flow: flowCfg,
      });
      wamid = r.wamid;
    } else if (isTemplate) {
      // Phase B：template message — templateMeta = { name, language, components }。
      // body = 預覽文字（永遠非空 — 上面空 body guard 唔會誤殺）。
      // 壞 meta → throw → 行現有 retry/FAILED 路徑（零新分支）。
      const meta = msg.templateMeta as { name?: string; language?: string; components?: TemplateComponent[] } | null;
      if (!meta?.name || !meta.language || !Array.isArray(meta.components)) {
        throw new Error("BAD_TEMPLATE_META");
      }
      const r = await sendTemplateMessage({
        phoneNumberId: clinic.waPhoneNumberId,
        to: contactRow.waId,
        templateName: meta.name,
        language: meta.language,
        components: meta.components,
      });
      wamid = r.wamid;
    } else {
      const r = await sendTextMessage({
        phoneNumberId: clinic.waPhoneNumberId,
        to: contactRow.waId,
        body,
      });
      wamid = r.wamid;
    }

    // ★ cwi-final S1-15：條件寫 — 只喺仍 SENDING 時寫 SENT（sweeper 可能先標咗 UNKNOWN）；
    //   count=0 → 仍補 wamid（drain / sweep 配對 key — UNKNOWN 收 sent/delivered webhook 會升返正常狀態）。
    const w = await prisma.message.updateMany({
      where: { id: msg.id, status: "SENDING" },
      data: { waMessageId: wamid, status: "SENT" },
    });
    if (w.count === 0) {
      log.warn({ messageId: msg.id, wamid }, "outbound: SENT 寫入時狀態已唔係 SENDING（sweeper 標咗 UNKNOWN？）— 仍然補 wamid");
      await prisma.message.updateMany({ where: { id: msg.id, waMessageId: null }, data: { waMessageId: wamid } });
    }
    // ★ cwi-final S1-1c：status 可能早過呢次 wamid 寫入（webhook 已 parked 入 PendingStatus）
    //   → wamid 寫入後即刻 drain。drain 失敗唔 throw（內部 catch + log.warn）→ 唔會重試主 job；sweep */2 兜底。
    await drainPendingStatuses(wamid);
    await touchConv(clinic.id, conv.id, msg.waTimestamp);
    // ★ cwi-final S1-4/S1-7：完整 payload 單一來源 + publishConvEvent（跨店 targeting + eventId 去重
    //   — 取代舊 assignee 補推；同店 assignee 收兩次 = clinic + staff room，client eventId 去重）
    const payload = await buildMessageNewPayload(msg.id);
    await publishConvEvent(convRef(conv), "message:new", payload);
    log.info(
      { clinic: clinic.code, messageId, wamid },
      "outbound: sent OK"
    );
  } catch (err) {
    // ★ cwi-final S1-15：Graph 呼叫 timeout（AbortSignal.timeout → TimeoutError）= Graph 可能已收
    //   → 結果未知 → 直接標 UNKNOWN（同 claim-miss 路徑）+ alert + UI 事件，唔重試（防雙發）。
    if (err instanceof Error && err.name === "TimeoutError") {
      log.warn(
        { clinic: clinic.code, messageId, attempts: job.attemptsMade + 1 },
        "outbound: graph timeout — outcome unknown, mark UNKNOWN (no retry)"
      );
      await markOutboundUnknown(msg.id, msg.conversationId, msg.waMessageId);
      return; // 唔重試
    }
    const permanent = isPermanentGraphError(err);
    const isFinal = permanent || job.attemptsMade + 1 >= maxAttempts;
    if (!isFinal) {
      // transient → 返 QUEUED 俾下次 attempt 重新 claim。
      // 條件式（只喺仍 SENDING 時）：sweeper 已標 UNKNOWN 時唔讓 zombie job 復活 QUEUED → 防雙發。
      await prisma.message.updateMany({
        where: { id: msg.id, status: "SENDING" },
        data: { status: "QUEUED" },
      });
      log.warn(
        { clinic: clinic.code, messageId, attempt: job.attemptsMade + 1, err: err instanceof Error ? err.message : String(err) },
        "outbound: send failed, will retry"
      );
      throw err; // → BullMQ 指數 backoff retry
    }
    // final → FAILED（現有邏輯）+ 通知 UI（紅色）
    await prisma.message
      .update({
        where: { id: msg.id },
        data: {
          status: "FAILED",
          errorCode: err instanceof Error ? truncateCode(err.message) : "UNKNOWN",
        },
      })
      .catch(() => undefined);
    // ★ cwi-r1close (D)：interactive（flow）訊息最終失敗 → 回滾對應 FlowSession SENT → FAILED。
    //   唔回滾時 dedup（status=SENT findFirst）會再中 → reused:true → UI 彈「已經發咗」而病人乜都冇收過。
    //   回滾後重按 = 開新 session 重發；成功 case 照舊 reused（防連撳語義保留）。
    if (msg.type === "interactive") {
      await prisma.flowSession
        .updateMany({
          where: { messageId: msg.id, status: "SENT" },
          data: { status: "FAILED" },
        })
        .catch(() => undefined);
    }
    // ★ cwi-final S1-4：conv room 事件轉 publishConvEvent（clinic room + 跨店目標）— conv 有齊五欄
    await publishConvEvent(convRef(conv), "message:status", {
      conversationId: conv.id,
      clinicId: clinic.id,
      waMessageId: msg.waMessageId ?? msg.id,
      status: "FAILED",
      errorCode: "SEND_FAILED",
    });
    // ★ cwi-final S1-15：最終失敗 → SYSTEM notice 畀發送者（sentByStaffId）或 assignee
    //   （口徑照 AI_FAILED notice；兩者都無 — 純 AI 無人手對話 — 唔建 notice 免噪音）。
    const noticeTarget = msg.sentByStaffId ?? conv.assigneeId;
    if (noticeTarget) {
      const finalCode = err instanceof Error ? truncateCode(err.message) : "UNKNOWN";
      await prisma.staffNotice
        .create({
          data: {
            clinicId: clinic.id,
            conversationId: conv.id,
            kind: "SYSTEM",
            title: "訊息發送失敗 — 請人手睇",
            meta: { reason: "SEND_FAILED", msgId: msg.id, wamid: msg.waMessageId ?? null, errorCode: finalCode },
          },
        })
        .catch((nErr) =>
          log.warn({ messageId, err: nErr instanceof Error ? nErr.message : String(nErr) }, "outbound: failed-notice create failed")
        );
      await publishConvEvent(convRef(conv), "notice:new", { clinicId: clinic.id, conversationId: conv.id, kind: "SYSTEM" }).catch(
        () => undefined
      );
    }
    log.error(
      { clinic: clinic.code, messageId, attempts: job.attemptsMade + 1, err: err instanceof Error ? err.message : String(err) },
      "outbound: permanently failed"
    );
    if (permanent) throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
    return; // 唔再 throw（job 完成，唔好令 queue 記錄成 failed）
  }
}

/**
 * ★ cwi-final S1-15：outbound 結果未知 → UNKNOWN（禁自動重發）+ HIGH alert + UI 事件。
 * 兩路徑共用：① claim miss（上次 attempt 死咗 mid-Graph-call）② 在途 timeout（TimeoutError）。
 * `outbound_unknown` 唔喺 HEALTH_OWNED_TYPES → 唔會自動 resolve，需人手跟。
 */
async function markOutboundUnknown(messageId: string, conversationId: string, wamid: string | null): Promise<void> {
  await prisma.message.update({
    where: { id: messageId },
    data: { status: "UNKNOWN", errorCode: "SEND_OUTCOME_UNKNOWN" },
  });
  await upsertAlert({ type: "outbound_unknown", severity: "HIGH", detail: { messageId } });
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
  });
  if (conv) {
    await publishConvEvent(conv, "message:status", {
      conversationId: conv.id,
      clinicId: conv.clinicId,
      // message:status zod 要 waMessageId 必填（同 EMPTY_BODY 既有 pattern）
      waMessageId: wamid ?? messageId,
      status: "UNKNOWN",
    });
  }
}

function truncateCode(s: string): string {
  return s.slice(0, 60).replace(/\s+/g, "_") || "UNKNOWN";
}

async function touchConv(clinicId: string, convId: string, ts: Date): Promise<void> {
  // ★ cwi-statusrole2-20260910（MD §4）：lastOutboundAt 維護點 — 只喺 SENT 成功路徑調（touchConv 唯一 call site），
  //   病人真正收到過 = 算覆。auto-resolve 守門 ②lastInboundAt <= lastOutboundAt 靠呢個欄。
  await prisma.$executeRaw`
    UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${ts}),
        "lastOutboundAt" = GREATEST(COALESCE("lastOutboundAt", ${ts}), ${ts}) WHERE "id" = ${convId}`;
  void clinicId;
}


export function startOutboundWorker(): Worker {
  const worker = new Worker<OutboundJobData>(
    outboundQueue.name,
    (job: Job<OutboundJobData>) => processOutboundJob(job),
    {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      // ★ Realtime P0 (R4)：唔准調大 — per-conversation ordering 靠佢（見 src/workers/concurrency.ts）；
      //   要 scale 先實施 group-by-conversationId（R8 觸發條件）。drift guard：pnpm test:ordering
      concurrency: OUTBOUND_CONCURRENCY,
    }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "outbound job completed");
  });
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "outbound job failed");
  });
  worker.on("error", (err) => {
    log.error(
      { queue: outboundQueue.name, err: err.message },
      "outbound worker error — exiting for PM2 restart"
    );
    process.exit(1);
  });

  return worker;
}
