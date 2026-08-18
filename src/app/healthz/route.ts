import { NextResponse } from "next/server";
import IORedis from "ioredis";
import log from "@/lib/log";
import prisma from "@/lib/prisma";

/**
 * Health endpoint — 框架 MD Phase 0 驗收：`/healthz` 回 200（檢查 DB/Redis/AI）。
 *
 * 規則（iron rule 6）：
 * - DB down 或 Redis down → 503
 * - AI down → 降級（200 + ai: "degraded"），唔算 fail（D6：AI 斷線 inbox 照常）
 *
 * 返回 JSON：{ db: "ok"|"down", redis: "ok"|"down", ai: "ok"|"down"|"degraded" }
 *   ai: "ok"       = /models 回 200
 *       "degraded" = 連唔到 / timeout（GPU 機離線，已知容忍狀態）
 *       "down"     = 連得到但服務端 error（5xx）— 有問題但唔影響 inbox
 */
export const dynamic = "force-dynamic"; // 唔好 static pre-render（build 時唔准打 DB/Redis）

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

async function checkDb(): Promise<"ok" | "down"> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "down";
  }
}

async function checkRedis(): Promise<"ok" | "down"> {
  // 獨立 probe client：短 timeout，唔共用 queue 嗰個（呢個有 maxRetriesPerRequest: null 會retry 到永遠）
  const probe = new IORedis(REDIS_URL, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  // probe 係短命 client — 加靜音 error listener，避免 Redis down 時 ioredis
  // 噴 "[ioredis] Unhandled error event" noise 入 PM2 error log（error 本身已 catch 處理）
  probe.on("error", () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return "ok";
  } catch {
    return "down";
  } finally {
    probe.disconnect();
  }
}

async function checkAi(): Promise<"ok" | "down" | "degraded"> {
  const base = process.env.AI_BASE_URL;
  if (!base) return "degraded"; // 未設定 = 視為降級（本地開發常見）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
      signal: controller.signal,
    });
    if (res.ok) return "ok";
    return "down"; // 連得到但 4xx/5xx
  } catch {
    return "degraded"; // 連唔到 / timeout — GPU 機離線
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const [db, redis, ai] = await Promise.all([
    checkDb(),
    checkRedis(),
    checkAi(),
  ]);

  const body = { db, redis, ai };
  const ok = db === "ok" && redis === "ok";
  if (!ok) {
    log.warn({ ...body }, "healthz: degraded");
  }
  return NextResponse.json(body, { status: ok ? 200 : 503 });
}
