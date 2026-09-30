/**
 * worker process 入口 — `node --import tsx dist/workers/index.js` 或直接 tsx
 *
 * 一個 process 行晒 8 個 worker（inbound/outbound/ai/ai-urgent/media/booking-write/cron-light/cron-heavy）。
 * mock E2E 同 dev 都咁跑；production 先拆 process。
 *
 * ★ cwi-final S6-5（worker 生命週期 + heartbeat）：
 * - graceful shutdown（SIGINT/SIGTERM）：wait 晒 in-flight job（BullMQ worker.close()）→ prisma disconnect → redis close → exit 0
 *   （舊行為：SIGTERM 直接死，in-flight job 留低；PM2 kill_timeout 8s 唔夠 Graph 慢 call）
 * - heartbeat 30s（`wa-inbox:worker:heartbeat` EX 90）→ /healthz workerOk（120s 窗口）— worker 死/掛 → 503
 * - 各 worker on("error") 唔再 process.exit（connection 層錯誤 — retryStrategy 無限重試自愈）
 *
 * 啟動首跑：refreshAllClinics()（fire-and-forget）— 立即填 L2 cache + WorkforceSyncState，
 * 唔使等首個 15 分鐘 cron boundary（health check 嘅 workforce_api_degraded 判斷要咁先正確）。
 */
import type { Worker } from "bullmq";
import "./env";
import { startInboundWorker } from "./inbound.worker";
import { startOutboundWorker } from "./outbound.worker";
import { startAiWorker, startAiUrgentWorker } from "./ai.worker";
import { startCronWorker, startCronHeavyWorker } from "./cron.worker";
import { startMediaWorker } from "./media.worker";
import { startBookingWriteWorker } from "./booking-write.worker"; // ★ cwi-final S5-1（F1）
import { closeRedis, cronHeavyQueue, cronQueue, getRedis } from "@/lib/queue";
import prisma from "@/lib/prisma";
import { refreshAllClinics } from "@/lib/availability";
import { CONTROL_CHANNEL, type ControlMessage, bustScopeCache } from "@/lib/notify";
import { applyCacheBust } from "@/lib/cache-bust";
import { retentionPolicyMismatches } from "@/lib/ops/retention-policy";
import { bootAlertChannelGuard, bootMockGuard } from "@/lib/boot-key-paths";
import log from "@/lib/log";

// ★ cwi-final S6-5：worker 生命週期 — workers array + graceful shutdown + heartbeat
const WORKER_HEARTBEAT_KEY = "wa-inbox:worker:heartbeat";

const workers: Worker[] = [];
let closing = false;

async function shutdown(sig: string) {
  if (closing) return;
  closing = true;
  // ★ cwi-qa CI-T692：shutdown 一開始就停 heartbeat — 舊版 interval 喺 close() 等 in-flight job 期間
  //   照寫 → 一個卡喺 graceful shutdown 嘅 worker（已停 poll、唔再做嘢）/healthz 永遠 200。
  //   停咗之後 key 最多 90s 過期 → 503（真實反映「冇 worker 接 job」）；唔 DEL — PM2 reload 時新 worker
  //   可能已寫咗新 heartbeat。
  clearInterval(heartbeatTimer);
  log.info({ sig }, "worker shutting down（graceful — 等晒 in-flight job）");
  // BullMQ Worker.close() = 停 poll + wait in-flight job 完成先返
  await Promise.allSettled(workers.map((w) => w.close()));
  await prisma.$disconnect().catch(() => undefined);
  await closeRedis();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// heartbeat：EX 90 + /healthz 120s 窗口 — worker 死/掛 → 90s 內 key 過期 → healthz 503
//   （外部 uptime monitor 每分鐘打 /healthz 接警；.unref() 唔阻 process exit）
const heartbeatTimer = setInterval(() => {
  void getRedis().set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", 90).catch(() => undefined);
}, 30_000).unref();

async function registerSchedulers() {
  // Phase 3 排程（BullMQ v6 upsertJobScheduler — id 冪等，重啟唔會重覆）
  // ★ cwi-final S6-5：所有 pattern 顯式 tz: "Asia/Hong_Kong"（唔再靠 process TZ — 部署 host 時區漂移唔再錯排程）
  // ★ cwi-final S6-5：拆兩條 lane — light（cronQueue, concurrency 4）+ heavy（cronHeavyQueue, concurrency 1）

  // ── light lane（sweep 類短 job）──────────────────────────────────────
  await cronQueue.upsertJobScheduler("sched-sync-availability", { pattern: "*/15 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "sync-availability",
    data: {},
  });
  await cronQueue.upsertJobScheduler("sched-bookings-expire", { pattern: "*/5 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "bookings-expire",
    data: {},
  });
  // consult v2.1 C3（MD §4.2 #23）：48h 無 inbound → active ConsultSession EXPIRED（冪等；env 可覆寫 idle 時長）
  await cronQueue.upsertJobScheduler("sched-consult-expire", { pattern: "*/5 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "consult-expire",
    data: {},
  });
  // Phase 4（MD §9.3）：5 分鐘健康自檢
  await cronQueue.upsertJobScheduler("sched-health-check", { pattern: "*/5 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "health-check",
    data: {},
  });
  // providerslot-20260830 T3：Flow hold 狀態推進 + held_timeout 警報（冪等，可空跑）
  await cronQueue.upsertJobScheduler("sched-hold-sweep", { pattern: "*/5 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "hold-sweep",
    data: {},
  });
  // cwi-h6-20260830（h5 §3）：auto-release — 負責人超時未回覆（三條件）→ 放手回隊列（冪等，可空跑）
  await cronQueue.upsertJobScheduler("sched-auto-release", { pattern: "*/5 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "auto-release",
    data: {},
  });
  // cwi-routing-20260906（§3）：投訴兩級升級第二級 — N 分鐘未接手 → 升級組（只升一次；冪等，可空跑）
  await cronQueue.upsertJobScheduler("sched-routing-escalate", { pattern: "*/5 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "routing-escalate",
    data: {},
  });
  // cwi-inboxfix-20260905（MD §1.4 I-5）：公海 SLA — 未指派超過 N 分鐘 → push 全店 active STAFF（冪等：slaNotifiedAt）
  await cronQueue.upsertJobScheduler("sched-unassigned-sla", { pattern: "*/5 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "unassigned-sla",
    data: {},
  });
  await cronQueue.upsertJobScheduler("sched-stuck-sweep", { pattern: "*/5 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "stuck-sweep",
    data: {},
  });
  // Phase B（cwi-tmpl-20260824-b1）：T-24h 預約提醒 — 每 15 分鐘掃（窗口 23–25h 內每 15 分鐘掃一次；
  // remindedAt 冪等 transaction 保證重覆掃描唔會重發）。
  // ★ cwi-final S0-8（D-1）：scan 本身常駐，但 cron.worker 入面 REMINDER_AUTO_SEND 未 =1 會 skip（零產出有 log）。
  // ★ cwi-final S6-5 偏離記錄：spec S6-5 拆表未列呢個 job — 保持現行 light lane（零行為改變；分類待 CEO 拍板）
  await cronQueue.upsertJobScheduler("sched-reminder-scan", { pattern: "*/15 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "reminder-scan",
    data: {},
  });
  // ★ cwi-final S1-1c（C-1③）：PendingStatus 排水兜底 — 每 2 分鐘（同 stuck-sweep 一條 light cron lane）
  //   （drain 配對到 Message 嘅 wamid + 24h 仍配對唔到 → 丟棄）
  await cronQueue.upsertJobScheduler("sched-pending-status-sweep", { pattern: "*/2 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "pending-status-sweep",
    data: {},
  });
  // ★ cwi-final S1-15 (P0-07)：outbound 兜底 — stale QUEUED（120s-6h）重加 + stuck SENDING（>5min）→ UNKNOWN
  //   （同 pending-status-sweep 一條 light cron lane，每 2 分鐘；冪等 — jobId dedup + updateMany）
  await cronQueue.upsertJobScheduler("sched-outbound-sweep", { pattern: "*/2 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "outbound-sweep",
    data: {},
  });

  // ── heavy lane（長批 job — 日報表 / purge / scan；concurrency 1）─────────────────
  // cwi-statusrole2-20260910（MD §4）：auto-resolve — 每日 03:00（顯式 tz HK — 同其他 job 一致）
  await cronHeavyQueue.upsertJobScheduler("sched-auto-resolve", { pattern: "0 3 * * *", tz: "Asia/Hong_Kong" }, {
    name: "auto-resolve",
    data: {},
  });
  await cronHeavyQueue.upsertJobScheduler("sched-quality-check", { pattern: "30 6 * * *", tz: "Asia/Hong_Kong" }, {
    name: "quality-check",
    data: {},
  });
  await cronHeavyQueue.upsertJobScheduler("sched-weekly-report", { pattern: "0 7 * * 1", tz: "Asia/Hong_Kong" }, {
    name: "weekly-report",
    data: {},
  });
  // Phase E（cwi-ai-20260825-t5）：週統計 + mining — 週一 05:00 HK（早過 weekly-report 07:00，
  // 等佢可以引用自動化摘要）
  await cronHeavyQueue.upsertJobScheduler("sched-stats-weekly", { pattern: "0 5 * * 1", tz: "Asia/Hong_Kong" }, {
    name: "stats-weekly",
    data: {},
  });
  // AI Workflow T1（cwi-ai-20260824-t1）：P0 retention purge — 每日 04:00 HK（顯式 tz — 同其他 job 一致）
  await cronHeavyQueue.upsertJobScheduler("sched-retention-purge", { pattern: "0 4 * * *", tz: "Asia/Hong_Kong" }, {
    name: "retention-purge",
    data: {},
  });
  // ★ cwi-followup-p0-20260915（MD §1.1）：公司主資料同步 — 每日 03:00（workforce → wa-inbox 快取；冪等）
  await cronHeavyQueue.upsertJobScheduler("sched-company-sync", { pattern: "0 3 * * *", tz: "Asia/Hong_Kong" }, {
    name: "company-sync",
    data: {},
  });
  // ★ cwi-followup-p3-20260916（followup-v2 MD §4.1）：follow-up 排程 — 每 10 分鐘掃 enabled 規則
  //   （A 對話空窗 / B1 預約 / B2 爽約 / C 術後 / D 召回 / E 報價；v3 恒 L1 — 只建 SUGGESTED 建議、cron 零發送；冪等查重重跑安全）
  await cronHeavyQueue.upsertJobScheduler("sched-followup-scan", { pattern: "*/10 * * * *", tz: "Asia/Hong_Kong" }, {
    name: "followup-scan",
    data: {},
  });

  log.info(
    {},
    "cron: schedulers registered（light=12/heavy=7，全部 tz=Asia/Hong_Kong）— light: sync-availability 15m, bookings-expire 5m, consult-expire 5m, health-check 5m, hold-sweep 5m, auto-release 5m, routing-escalate 5m, unassigned-sla 5m, stuck-sweep 5m, reminder-scan 15m, pending-status-sweep 2m, outbound-sweep 2m；heavy: auto-resolve daily 03:00, quality-check daily 06:30, weekly-report Mon 07:00, stats-weekly Mon 05:00, retention-purge daily 04:00, company-sync daily 03:00, followup-scan 10m"
  );
}

async function main() {
  // ★ cwi-final S0-1：production 開 mock flag → 拒絕啟動（fail-closed；ALLOW_MOCK_IN_PROD=1 放行 sandbox）
  bootMockGuard();
  // ★ cwi-final S6-5：production ALERT_CHANNEL 唔准係 "log"（警報只入 log 檔 = 冇人睇到）— 大字 log，唔 exit（bootMockGuard 同一位置）
  bootAlertChannelGuard();

  // ★ cwi-final S0-11（D-3）：唔再 exit — worker 照開；retention-purge 會自己跳過（見 retention-purge.ts），
  //   health-check 開 HIGH alert `retention_env_mismatch` 直至修好 env。
  {
    const mismatches = retentionPolicyMismatches();
    if (mismatches.length > 0) {
      log.error({ mismatches }, "worker: 保留期 env 同政策唔一致 — worker 照開，但 retention-purge 會跳過直至修正（S0-11）");
    }
  }
  workers.push(startInboundWorker());
  workers.push(startOutboundWorker());
  workers.push(startAiWorker());
  // ★ cwi-final S1-14：急症通道獨立 lane（concurrency 1 — 見 src/workers/concurrency.ts）
  workers.push(startAiUrgentWorker());
  workers.push(startMediaWorker());
  // ★ cwi-final S5-1（F1）：booking-write — createBooking 異步寫 Apricot（concurrency 1）
  workers.push(startBookingWriteWorker());
  workers.push(startCronWorker());
  // ★ cwi-final S6-5：cron-heavy lane — 長批 job 獨立 concurrency 1（唔阻 light lane sweep）
  workers.push(startCronHeavyWorker());
  await registerSchedulers();
  // ★ Fix B（cwi-fix-20260825-f1）：worker process 訂閱 control channel —
  //   automation/workflow cache 失效唔使等 5 分鐘 TTL（panic 降級要即時生效）。
  //   subscribe 独占 connection → duplicate（同 hub.ts initControlBridge 一樣做法）。
  const controlSub = getRedis().duplicate();
  controlSub.on("error", (err) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "worker control subscriber error");
  });
  controlSub.subscribe(CONTROL_CHANNEL, (err) => {
    if (err) log.error({ err: err.message }, "worker control subscribe failed（cache 退回 5 分鐘 TTL）");
  });
  controlSub.on("message", (_ch, raw) => {
    try {
      const data = JSON.parse(raw) as ControlMessage;
      if (data.cmd === "cache:bust") applyCacheBust(data.scope);
      // ★ cwi-final S1-4：staff 範圍/技能組改動 → 清本 process 嘅 publishConvEvent scope cache
      else if (data.cmd === "scope:changed") bustScopeCache();
      // staff:* cmd 係 web/socket 事 — worker 唔理
    } catch {
      /* bad message ignored（同 hub 語義）*/
    }
  });
  log.info({}, "all workers running — waiting for jobs");

  // ★ cwi-final S6-5（偏離記錄）：啟動即寫第一次 heartbeat — 唔使等 30s interval 首發，
  //   全新 worker 起機後 /healthz workerOk 窗口 30s → ~0s（mock-e2e / T692 重起 worker 後即刻可斷言 200）
  void getRedis()
    .set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", 90)
    .catch(() => undefined);

  // 啟動首跑（fire-and-forget — 失敗只 log，*/15 cron 會再試）
  void refreshAllClinics().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "worker: startup availability refresh failed");
  });
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? (err.stack ?? err.message) : String(err) }, "worker fatal");
  process.exit(1);
});
