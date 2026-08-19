import { getRedis } from "@/lib/queue";
import log from "@/lib/log";

/**
 * 跨 process 實時通知橋（Redis pub/sub）。
 *
 * 架構：web server（Socket.IO）同 BullMQ workers 係兩個 PM2 process。
 * Worker 處理完 webhook event 後，冇辦法直接 emit 去 web process 嘅 io —
 * 所以經 Redis publish：
 *
 *   worker → publishNotify(clinicId, event, payload)
 *            → Redis channel "wa-inbox:notify"
 *   web    → subscriber 收到 → io.to(`clinic:${clinicId}`).emit(event, payload)
 *
 * ★ PII 邊界：payload 含訊息內容（病人/店員都要見到嘅 chat 內容）—
 * 只喺自己 VPS 嘅 Redis 內傳，唔出公網。log 只帶 event/clinicId metadata。
 */

export const NOTIFY_CHANNEL = "wa-inbox:notify";

export interface NotifyMessage {
  clinicId: string;
  event: string;
  payload: unknown;
}

// ── Control channel（P0-3 停用即時斷線） ──────────────────────────────────
//
// ★ 點解要經 Redis 而唔係直接調 disconnectStaff()：
//   custom server 架構下，server.ts（持 io + staffSockets map）同 Next 編譯咗嘅
//   API route handler 各持一份 hub.ts module instance（dev 下两套 module graph；
//   prod standalone 亦會係唔同 require cache key）— route 直接調 disconnectStaff()
//   會落到 state.io === null 嗰份 instance → 靜默 return 0（E2E T42 捉住）。
//   經 Redis publish 過一次，就由「真正持 io 嗰份 instance」去斷線 — 同一個
//   process（dev）或者另一個 PM2 cluster node（socket 喺邊個 node 就由邊個斷）都 work。
export const CONTROL_CHANNEL = "wa-inbox:control";

export type ControlMessage =
  | { cmd: "staff:changed"; staffId: string; active: boolean }
  // C-3 尾批：password reset → 踢晒該 staff 所有 session（hub 側設 cutoff + 斷已連 socket）
  | { cmd: "staff:sessions-invalidated"; staffId: string };

/**
 * 發控制指令（fire-and-forget）：Redis 故障時 log — API 側嘅 cache 失效已經做咗，
 * socket 斷線會延後到 active cache 60s 到期（fail-closed 兜底）。
 */
export function publishControl(msg: ControlMessage): void {
  getRedis()
    .publish(CONTROL_CHANNEL, JSON.stringify(msg))
    .catch((err) => {
      log.warn(
        { cmd: msg.cmd, staffId: msg.staffId, err: err instanceof Error ? err.message : String(err) },
        "control: publish failed（socket 斷線會延後到 active cache 到期）"
      );
    });
}

/**
 * 發通知（fire-and-forget）：Redis 故障唔應該阻塞 inbound pipeline
 * （UI 會經 reconnect backlog 補齊）。
 */
export function publishNotify(clinicId: string, event: string, payload: unknown): void {
  const data = JSON.stringify({ clinicId, event, payload } satisfies NotifyMessage);
  getRedis()
    .publish(NOTIFY_CHANNEL, data)
    .catch((err) => {
      log.warn(
        { clinicId, event, err: err instanceof Error ? err.message : String(err) },
        "notify: publish failed (UI 會經 reconnect 補漏)"
      );
    });
}
