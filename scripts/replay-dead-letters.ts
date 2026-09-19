/**
 * ★ cwi-final S1-1a — DLQ 重放 CLI。
 *
 * 讀 `DeadLetter`（queue=inbound, replayedAt IS NULL）→ decrypt → `inboundQueue.add("event", data)`
 * → 標 replayedAt。WebhookEvent claim 冪等 → 重放安全（重複事件靜默 skip，訊息唔會重複入 DB）。
 *
 * 用法：pnpm tsx scripts/replay-dead-letters.ts
 * 輸出：行數（replayed / total / failed）。exit 0 = 全數成功（或 0 行）；exit 1 = 有行失敗（留底再試）。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { replayUnreplayedDeadLetters } from "../src/lib/ops/dead-letter";

async function main(): Promise<void> {
  const r = await replayUnreplayedDeadLetters();
  console.log(`replay-dead-letters: ${r.replayed}/${r.total} replayed（failed ${r.failed}）`);
  process.exit(r.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("replay-dead-letters failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
