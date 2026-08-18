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
