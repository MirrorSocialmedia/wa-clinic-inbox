/**
 * WA Clinic Inbox — PM2 進程配置（框架 MD §2）
 *
 * 兩個 process：
 * - wa-inbox  : web server（Next.js + Socket.IO，port 3100）
 * - wa-worker : BullMQ workers（inbound/outbound/ai/cron）
 *
 * 用法：
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs wa-inbox / wa-worker
 *   pm2 reload wa-inbox   # 零 downtime（web server 單 instance，實際係 restart）
 */
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
      env: {
        NODE_ENV: "production",
        PORT: 3100,
      },
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
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 4000,
      exp_backoff_restart_delay: 100,
      kill_timeout: 8000,
      max_memory_restart: "1024M",
      env: {
        NODE_ENV: "production",
      },
      error_file: "logs/wa-worker-error.log",
      out_file: "logs/wa-worker-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
