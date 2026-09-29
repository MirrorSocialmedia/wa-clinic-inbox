import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // App Review 三件套（2026-08-20）：Next 15.5 起 unauthorized()/forbidden() 要呢個 flag。
  // 只被 (admin)/admin/layout.tsx + onboarding/templates 頁用（非 ADMIN → 403 / unauth → 401 防線二）；
  // repo 其他任何地方未用過 — 爆炸範圍受控。
  experimental: {
    authInterrupts: true,
  },
  // ★ cwi-qa CI-E6（dev-only；`next build`/`start` 完全唔受影響）：`next dev` 每次 rebuild 都重寫
  //   .next/*manifest.json；同一刻有 request 讀緊 → `⨯ SyntaxError: Unexpected end of JSON input` → HTML 500
  //  （CI run #17 T672(c)、run #18 H6-MC-UI release /assign 500 + T151/T169；本地 server log 實錚）。
  //   ① 真觸發源：Tailwind v4（@tailwindcss/postcss 自動 source detection）將成個 project root 註冊做
  //      webpack context dependency → root 下任何檔變 = client rebuild。mock-e2e / mock client 不停寫
  //      `.dev/*.json`（workforce-mock-calls.jsonl 每次 mock call 都 append）→ 一個 run 幾百次 rebuild。
  //      `.dev/` 係 runtime mock 狀態（gitignored），唔係 source → 由 watcher 剔走（Next 預設 regex + `.dev`）。
  //   ② 唔好 dispose 已編譯 route：預設 maxInactiveAge 60s + pagesBufferLength 5 → 閒 60s 嘅 route 被丟、
  //      再 hit 再 compile（本地 log 見同一 route compile 兩次）。
  onDemandEntries: {
    maxInactiveAge: 24 * 60 * 60 * 1000,
    pagesBufferLength: 1000,
  },
  webpack(config, { dev }) {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: /^((?:[^/]*(?:\/|$))*)(\.(git|next|dev)|node_modules)(\/((?:[^/]*(?:\/|$))*)(?:$|\/))?/,
      };
    }
    return config;
  },
  // native / 運行時綁 engine 嘅套件唔好畀 webpack bundle（custom server + route handlers）
  serverExternalPackages: [
    "@prisma/client",
    "prisma",
    "argon2",
    "ioredis",
    "bullmq",
    "pino",
    "socket.io",
  ],
  // ★ cwi-realtime-fix §8.1 #1：/sw.js 明確 no-cache — 瀏覽器每次註冊/更新都打網絡。
  //   SW 更新策略同 sw-registrar.tsx 嘅 updateViaCache:"none" + 主動 update loop 配對。
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          // S3-9：CSP 先 report-only（dev HMR 有 inline/eval — enforce 會殺 playwright 段；
          // 跑一日收集 violation 後先轉 Content-Security-Policy enforce）。
          // Embedded Signup 頁需要 connect.facebook.net（spec 註）。
          {
            key: "Content-Security-Policy-Report-Only",
            value:
              "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss: https://connect.facebook.net; " +
              "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
