/**
 * e2e-queue-clear — E2E 開跑前清晒 BullMQ 殘留 job。
 *
 * 點解需要：E2E sandbox 共享 Redis。之前 run 被 kill 時（e2e cleanup / 人手 kill /
 * 兩個 e2e 平行跑）active/stalled job 會留喺 queue — 新 run 嘅 worker 會 redeliver
 * 舊 job → 舊 EPOCH 嘅 history/inbound job 落咗新 run 嘅 DB，污染斷言
 * （E2E T41 捉住：舊 run 嘅 T41 history job 喺新 run 中間補跑，timing 全亂）。
 *
 * 用法：pnpm e2e:queue-clear
 * 淨係清 job（waiting/delayed/active/failed/completed）— 唔郁 scheduler（cron queue）。
 */
import { inboundQueue, outboundQueue, aiQueue } from "@/lib/queue";

const queues = [inboundQueue, outboundQueue, aiQueue];

async function main(): Promise<void> {
  for (const q of queues) {
    await q.drain(); // waiting + delayed 移除
    await q.clean(0, -1, "failed");
    await q.clean(0, -1, "completed");
    await q.clean(0, -1, "active"); // 舊 worker 被 kill 後留低嘅 active 殘骸
  }
  console.log("queue clear OK: inbound/outbound/ai drained (cron scheduler 保留)");
  process.exit(0);
}

main().catch((err) => {
  console.error("queue clear failed:", err);
  process.exit(1);
});
