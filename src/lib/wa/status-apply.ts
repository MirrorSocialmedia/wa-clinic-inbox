/**
 * ★ cwi-final S1-1c（C-1③ / audit3 P1-06）— status monotonic apply + PendingStatus 排水（worker 共用）。
 *
 * 背景：status 早過訊息（outbound Graph 已回 wamid 但 waMessageId 未寫入 / APP_ECHO 未落庫）
 * → handleStatuses 同 tx parked 入 PendingStatus（零 PII）。呢度提供兩個共用入口：
 *
 *  1. applyStatusInTx(tx, msg, incoming, errorCode) — nextStatus 判斷 + tx.message.update。
 *     只升唔降（見 status-rank.ts）；FAILED 時寫 errorCode。純 worker/tx 內用。
 *  2. drainPendingStatuses(wamid) — 配對成功（Message 已有 waMessageId）時 drain：
 *     tx 內 findMany(wamid) → 搵 Message → 無 msg 或 0 行 = no-op → rows 按 rank 低到高
 *     逐個 apply（FAILED 排最後）→ deleteMany(wamid) → 有改動先 emit。
 *     ★ 失敗唔 throw（catch + log.warn）— 調用點（outbound/APP_ECHO/sweep）唔好因為 drain
 *     失敗而重試主 job；sweeper 每 2 分鐘再試。
 *
 * emit 用現有 publishNotify(clinicId, "message:status", …)（同 inbound.worker 現有 pattern；
 * 唔 import S1-4 嘅 publishConvEvent — 嗰個 B7 先有）。clinicId 由 Message.conversation.clinicId 取。
 */
import { Prisma, type MsgStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { publishConvEvent, convRef } from "@/lib/notify";
import { nextStatus, STATUS_RANK } from "./status-rank";

/** interactive transaction 嘅 tx client type（top-level prisma 都用同一套 model API）。 */
type Tx = Prisma.TransactionClient;

/**
 * 單條 monotonic apply（★ 只准喺 $transaction 內用 — 要同 caller 嘅業務寫入原子）。
 * @returns 實際寫入嘅新狀態；null = 唔改（倒退／同級／終態語義擋下）。
 */
export async function applyStatusInTx(
  tx: Tx,
  msg: { id: string; status: string },
  incoming: string,
  errorCode: string | null,
): Promise<string | null> {
  const next = nextStatus(msg.status, incoming);
  if (next === null) return null;
  const status = next as MsgStatus; // nextStatus 回傳範圍 ⊆ MsgStatus（純 string 函數，type 收窄）
  await tx.message.update({
    where: { id: msg.id },
    // FAILED 時先寫 errorCode（Meta error code — 非 PII）；其他狀態唔郁呢欄。
    data: status === "FAILED" ? { status, errorCode } : { status },
  });
  return status;
}

interface DrainEmit {
  conversationId: string;
  clinicId: string;
  status: string;
  errorCode: string | null;
}

/**
 * drain 指定 wamid 嘅 PendingStatus 行（Message 已配對先有謂）。
 * ★ 永遠唔 throw — 失敗 log.warn 上嚟由 sweep 兜底。
 */
export async function drainPendingStatuses(wamid: string): Promise<void> {
  try {
    const emit = await prisma.$transaction(async (tx): Promise<DrainEmit | null> => {
      const rows = await tx.pendingStatus.findMany({ where: { wamid } });
      // 0 行 = no-op（webhook 重發 / 已 drain 走）
      if (rows.length === 0) return null;
      const msg = await tx.message.findUnique({ where: { waMessageId: wamid } });
      // 未配對 = no-op（留俾下一排水點 / sweep；24h 後 sweep 丟棄）
      if (!msg) return null;
      const conv = await tx.conversation.findUnique({
        where: { id: msg.conversationId },
        select: { id: true, clinicId: true },
      });
      if (!conv) return null;

      // rows 按 rank 低到高逐個 apply（FAILED 排最後）— 一次過行曬，
      // 中間態唔會被漏（例如 parked [SENT, DELIVERED] 一次 drain 到 DELIVERED）。
      const sorted = [...rows].sort((a, b) => rankOf(a.status) - rankOf(b.status));
      const cur: { id: string; status: string } = { id: msg.id, status: msg.status };
      let applied: string | null = null;
      let errorCode: string | null = null;
      for (const row of sorted) {
        const r = await applyStatusInTx(tx, cur, row.status, row.errorCode);
        if (r !== null) {
          cur.status = r; // ★ 本地跟進 — 後面對 FAILED 嘅判斷要用最新 status
          applied = r;
          errorCode = row.errorCode;
        }
      }

      // 配對到 = 全部 pending 行都處理完（apply 或 stale no-op）→ 清行（冪等 key 釋放）。
      await tx.pendingStatus.deleteMany({ where: { wamid } });
      return applied === null
        ? null
        : { conversationId: conv.id, clinicId: conv.clinicId, status: applied, errorCode };
    });

    if (emit) {
      // 現有 message:status emit pattern（同 inbound.worker handleStatuses）
      // ★ cwi-final S1-4：conv room 事件轉 publishConvEvent — emit 只有 conversationId+clinicId → 補五欄
      const convRow = await prisma.conversation.findUnique({
        where: { id: emit.conversationId },
        select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
      });
      if (convRow) {
        await publishConvEvent(convRef(convRow), "message:status", {
          conversationId: emit.conversationId,
          clinicId: emit.clinicId,
          waMessageId: wamid,
          status: emit.status,
          errorCode: emit.errorCode,
        });
      }
      log.info(
        { wamid, status: emit.status, errorCode: emit.errorCode },
        "pending-status: drained + applied"
      );
    }
  } catch (err) {
    // ★ 失敗唔 throw — 調用點（outbound/APP_ECHO/sweep）唔好因 drain 失敗重試主 job；
    //   sweep 每 2 分鐘再試，24h 丟棄兜底。
    log.warn(
      { wamid, err: err instanceof Error ? err.message : String(err) },
      "pending-status: drain failed（sweeper 再試）"
    );
  }
}

/** FAILED 排最後；未知狀態跟 rank（預設 0）。 */
function rankOf(status: string): number {
  if (status === "FAILED") return Number.MAX_SAFE_INTEGER;
  return STATUS_RANK[status] ?? 0;
}
