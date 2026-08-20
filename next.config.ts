import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // App Review 三件套（2026-08-20）：Next 15.5 起 unauthorized()/forbidden() 要呢個 flag。
  // 只被 (admin)/admin/layout.tsx + onboarding/templates 頁用（非 ADMIN → 403 / unauth → 401 防線二）；
  // repo 其他任何地方未用過 — 爆炸範圍受控。
  experimental: {
    authInterrupts: true,
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
};

export default nextConfig;
