import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
