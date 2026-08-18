import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient singleton — dev 時 hot-reload 唔好每次都開新 connection pool。
 * 所有 DB access 都經呢個 instance（webhook / healthz / workers / API routes）。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      // 只 log error — query/慢 query log 會帶参数，PII 風險，Phase 1 需要時再加（必經 redactDeep）
      { level: "error", emit: "event" },
    ],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
