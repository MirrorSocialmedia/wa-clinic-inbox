/**
 * WA Clinic Inbox — PM2 進程配置（框架 MD §2）
 *
 * 兩個 process：
 * - wa-inbox  : web server（Next.js + Socket.IO，port 3100）
 * - wa-worker : BullMQ workers（inbound/outbound/ai/ai-urgent/media/booking-write/cron/cron-heavy）
 *
 * 用法：
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs wa-inbox / wa-worker
 *   pm2 reload wa-inbox   # 零 downtime（web server 單 instance，實際係 restart）
 *
 * ★ cwi-final S6-5：
 * - wa-worker kill_timeout 30s（graceful shutdown 要等晒 in-flight job — Graph 慢 call 5s+ 先夠）
 * - wa-worker 刪 max_restarts（worker 有 heartbeat + queue 無限重試自愈 — 唔再靠 PM2 崩了重啟；
 *   真係 crash-loop 會由 uptime monitor 接警，唔係靜默重啟）
 * - 兩 app 顯式 TZ=Asia/Hong_Kong（cron pattern 已顯式 tz，雙保險）
 */
/**
 * ★ cwi-qa FX-06（QA-06）：statement_timeout 只限 web —
 *   S6 migration 曾 `ALTER ROLE wa_inbox SET statement_timeout = '8s'`（web/worker/migrate 共用 role）
 *   → cron 批量 SQL / FOR UPDATE 等鎖 / 大 migration 會被殺。
 *   migration 20260928000100_cwi_qa_fx06_reset_timeout 已 RESET role；8s 改由 web process
 *   自己嘅 DATABASE_URL options 參數承載（`&options=-c%20statement_timeout%3D8000` = percent-encoded
 *   libpq startup option `-c statement_timeout=8000`，connection 級、唔污染 role）。
 *   worker / migrate 唔加 = 0 = 無超時。
 *   .env 開機時讀（PM2 唔 auto-load .env），零密碼硬編碼入本檔。
 */
const fs = require("fs");
const path = require("path");

function webDatabaseUrlWithTimeout() {
  let raw = "";
  try {
    const m = fs.readFileSync(path.join(__dirname, ".env"), "utf8").match(/^DATABASE_URL=(.+)$/m);
    raw = m ? m[1].trim() : "";
    // .env 約定：值可帶雙引號（loadEnvConfig 會 strip）— 手動讀要同口徑
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
  } catch {
    /* 無 .env — app 照原有載入路徑（loadEnvConfig），唔強制 */
  }
  if (!raw || raw.includes("statement_timeout")) return undefined; // 已帶 option 唔重複 add
  return raw + (raw.includes("?") ? "&" : "?") + "options=-c%20statement_timeout%3D8000";
}

// ★ cwi-qa FX-06：web env（唔帶 DATABASE_URL 時行為同舊版完全一致 — 避免 PM2 序列化 undefined）
const waInboxEnv = {
  NODE_ENV: "production",
  PORT: 3100,
  TZ: "Asia/Hong_Kong", // ★ cwi-final S6-5
};
const fx06WebUrl = webDatabaseUrlWithTimeout();
if (fx06WebUrl) waInboxEnv.DATABASE_URL = fx06WebUrl; // worker 唔加 = 無超時

module.exports = {
  apps: [
    {
      name: "wa-inbox",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "server.ts",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 4000,
      exp_backoff_restart_delay: 100,
      kill_timeout: 8000,
      max_memory_restart: "1024M",
      env: waInboxEnv,
      error_file: "logs/wa-inbox-error.log",
      out_file: "logs/wa-inbox-out.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "wa-worker",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/workers/index.ts",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // ★ cwi-final S6-5：刪 max_restarts — worker 自愈靠 heartbeat + 無限重試；
      //   crash-loop 要接警（uptime monitor）唔好靜默重埋
      min_uptime: "10s",
      restart_delay: 4000,
      exp_backoff_restart_delay: 1000, // ★ cwi-final S6-5：100 → 1000（graceful shutdown 窗口夠大）
      kill_timeout: 30000, // ★ cwi-final S6-5：8s → 30s（等晒 in-flight job）
      max_memory_restart: "1024M",
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Hong_Kong", // ★ cwi-final S6-5（cron tz 雙保險 — pattern 已顯式 Asia/Hong_Kong）
      },
      error_file: "logs/wa-worker-error.log",
      out_file: "logs/wa-worker-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
