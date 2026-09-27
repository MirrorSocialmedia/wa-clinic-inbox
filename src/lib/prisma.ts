import { PrismaClient } from "@prisma/client";
import log from "@/lib/log";

/**
 * PrismaClient singleton — dev 時 hot-reload 唔好每次都開新 connection pool。
 * 所有 DB access 都經呢個 instance（webhook / healthz / workers / API routes）。
 *
 * ★ cwi-final S6-4：ClientOptions 顯式帶 log array type — 預設 PrismaClient 泛型推唔到
 * log config（ClientOptions['log'] 係 union 含 undefined）→ $on 參數推成 never（tsc red）。
 * tuple type 令 GetEvents 推得出 U = "error"。
 */
type WaPrismaClient = PrismaClient<{ log: [{ level: "error"; emit: "event" }] }>;

const globalForPrisma = globalThis as unknown as { prisma?: WaPrismaClient };

export const prisma: WaPrismaClient =
  globalForPrisma.prisma ??
  (new PrismaClient({
    log: [
      // 只 log error — query/慢 query log 會帶参数，PII 風險，Phase 1 需要時再加（必經 redactDeep）
      { level: "error", emit: "event" },
    ],
  }) as unknown as WaPrismaClient);

// ★ cwi-final S6-4：Prisma error 事件 → structured log（之前 log 設咗 emit:"event" 但冇 listener = 錯埋埋唔見）。
// metadata only：target + 截斷錯誤訊息（Prisma error message 唔含 query params / 資料內容 — PII 鐵律安全）。
prisma.$on("error", (e) => {
  log.error({ target: e.target, message: e.message.slice(0, 300) }, "prisma error");
});

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
