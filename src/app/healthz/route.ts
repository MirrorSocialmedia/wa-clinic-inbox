import { type NextRequest, NextResponse } from "next/server";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import log from "@/lib/log";
import prisma from "@/lib/prisma";
import { QUEUE_PREFIX } from "@/lib/queue";
import { checkAiHealth, type AiHealth } from "@/lib/ai";
import { checkMediaBoot } from "@/lib/wa/media";

/**
 * Health endpoint — 框架 MD Phase 0 驗收：`/healthz` 回 200（檢查 DB/Redis/AI）。
 *
 * 規則（iron rule 6）：
 * - DB down 或 Redis down → 503
 * - ★ cwi-final S6-5：worker down（heartbeat 無 / >120s）→ 503；inbound queue lag（oldest waiting >60s）→ 503
 * - AI down → 降級（200 + ai: "degraded"），唔算 fail（D6：AI 斷線 inbox 照常）
 *
 * 返回 JSON：{ db: "ok"|"down", redis: "ok"|"down", ai: "ok"|"down"|"degraded",
 *             worker: "ok"|"down", inboundLag: { ok, oldestAgeMs },
 *             security: { diskEncrypted, mediaDir } }
 *   ai: "ok"       = mock mode（AI_MOCK=1）或 /models 回 200
 *       "degraded" = 連唔到 / timeout / 未設定（GPU 機離線，已知容忍狀態）
 *       "down"     = 連得到但服務端 error（5xx）— 有問題但唔影響 inbox
 *   worker（★ cwi-final S6-5）：
 *     "ok"   = `wa-inbox:worker:heartbeat`（worker 每 30s 寫、EX 90）age < 120s
 *     "down" = key 無 / 過期 / age ≥ 120s（worker 死咗 / 掛咗 / 首 30s 之前未寫）
 *   inboundLag（★ cwi-final S6-5）：
 *     ok = inbound queue 無 waiting job，或者最舊 waiting job age < 60s
 *     （worker 死咗之後 backlog 會即刻堆 — lag 係 heartbeat 之外嘅第二重 worker 存活訊號）
 *   security（安全審計 C-1 boot assertion 曝光位 — 「未加密碟」冇得靜默）：
 *     diskEncrypted = production 時 DISK_ENCRYPTED=1 係咪設咗（true/false）；非 production = null（dev 唔計）
 *     mediaDir      = "ok" | "dev-fallback" | "error"（error = production 媒體落唔到碟）
 *
 * S3-9 token gate：
 * - 公開（無 token）→ 只回 `{ ok }`（liveness；200/503 語義不變）
 * - `?token=$HEALTHZ_TOKEN` 正確 → 詳細 body（db/redis/ai/worker/inboundLag/security）
 * - 帶 token 但唔正確 → 401（fail-closed）
 * - HEALTHZ_TOKEN 未設（dev 便利）→ gate 停用，直接回詳細 body
 *
 * 外部 uptime monitor（UptimeRobot / Cloudflare Health Check）每分鐘打 `/healthz`，
 * 503 → 通知 Kenneth（★ cwi-final S6-5 起包括 worker 死 / inbound 堆積）。
 */
export const dynamic = "force-dynamic"; // 唔好 static pre-render（build 時唔准打 DB/Redis）

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// ★ cwi-final S6-5：heartbeat key（worker process 每 30s 寫 EX 90 — 見 src/workers/index.ts）
const WORKER_HEARTBEAT_KEY = "wa-inbox:worker:heartbeat";
const WORKER_HEARTBEAT_MAX_AGE_MS = 120_000;
const INBOUND_LAG_MAX_AGE_MS = 60_000;

async function checkDb(): Promise<"ok" | "down"> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "down";
  }
}

/** 短命 probe client：短 timeout，唔共用 queue 嗰個（呢個有 maxRetriesPerRequest: null 會retry 到永遠）。 */
function createProbe(): IORedis {
  const probe = new IORedis(REDIS_URL, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  // probe 係短命 client — 加靜音 error listener，避免 Redis down 時 ioredis
  // 噴 "[ioredis] Unhandled error event" noise 入 PM2 error log（error 本身已 catch 處理）
  probe.on("error", () => undefined);
  return probe;
}

async function checkRedis(probe: IORedis): Promise<"ok" | "down"> {
  try {
    await probe.connect();
    await probe.ping();
    return "ok";
  } catch {
    return "down";
  }
}

// ★ cwi-final S6-5：worker heartbeat（worker 每 30s SET EX 90；key 死 = worker 死 / 掛）
async function checkWorkerHeartbeat(probe: IORedis): Promise<{ workerOk: boolean; heartbeatAgeMs: number | null }> {
  try {
    const raw = await probe.get(WORKER_HEARTBEAT_KEY);
    const hb = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(hb)) return { workerOk: false, heartbeatAgeMs: null };
    const ageMs = Date.now() - hb;
    return { workerOk: ageMs < WORKER_HEARTBEAT_MAX_AGE_MS, heartbeatAgeMs: ageMs };
  } catch {
    return { workerOk: false, heartbeatAgeMs: null };
  }
}

// ★ cwi-final S6-5：inbound queue lag（最舊 waiting job 嘅 age — worker 死後 backlog 即堆）
//   Queue 綁定 probe（短命 client）— 唔共用 queue.ts 嗰個 maxRetriesPerRequest:null 連線（Redis down 會 hang）
async function checkInboundLag(probe: IORedis): Promise<{ lagOk: boolean; oldestAgeMs: number | null }> {
  try {
    const queue = new Queue("inbound", { connection: probe, prefix: QUEUE_PREFIX });
    const oldest = await queue.getWaiting(0, 0);
    if (oldest.length === 0) return { lagOk: true, oldestAgeMs: null };
    const ageMs = Date.now() - oldest[0].timestamp;
    return { lagOk: ageMs < INBOUND_LAG_MAX_AGE_MS, oldestAgeMs: ageMs };
  } catch {
    // 讀失敗（redis 已 ping 成功，正常唔會行到呢度）→ fail-open：redis 狀態已由 checkRedis 覆蓋
    return { lagOk: true, oldestAgeMs: null };
  }
}

// AI probe 抽到 lib/ai/health.ts（Phase 2 起同 /admin AI 狀態卡共用）：
// - AI_MOCK=1 → "ok"（mock 永遠喺度）
// - real mode：GET {VLLM_BASE_URL}/models（3s timeout）
async function checkAi(): Promise<AiHealth> {
  return checkAiHealth();
}

// 一次性 ERROR（boot assertion 曝光 — 每次 healthz hit 重打會爆 log；module-level flag）
let securityErrorLogged = false;

export async function GET(req: NextRequest) {
  const probe = createProbe();
  const redis = await checkRedis(probe);
  const [db, ai, media, worker, lag] = await Promise.all([
    checkDb(),
    checkAi(),
    checkMediaBoot(),
    redis === "ok"
      ? checkWorkerHeartbeat(probe)
      : Promise.resolve({ workerOk: false, heartbeatAgeMs: null as number | null }),
    redis === "ok" ? checkInboundLag(probe) : Promise.resolve({ lagOk: true, oldestAgeMs: null as number | null }),
  ]);
  probe.disconnect();

  const isProd = process.env.NODE_ENV === "production";
  const diskEncrypted = isProd ? process.env.DISK_ENCRYPTED === "1" : null;
  const body = {
    db,
    redis,
    ai,
    // ★ cwi-final S6-5：worker 生命週期 + inbound lag（加入 503 判定）
    worker: worker.workerOk ? "ok" : "down",
    inboundLag: { ok: lag.lagOk, oldestAgeMs: lag.oldestAgeMs },
    security: { diskEncrypted, mediaDir: media.status },
  };

  // production 未加密碟 / media 死咗 → ERROR 一次（healthz 字段常時紅，監視系統可以抓）
  if (isProd && (diskEncrypted === false || media.status === "error") && !securityErrorLogged) {
    securityErrorLogged = true;
    log.error(
      { diskEncrypted, mediaDir: media.status, dir: media.dir },
      "healthz: ⚠️ at-rest 安全 bootstrap 未確認（DISK_ENCRYPTED / media dir）— 見 deploy runbook"
    );
  }

  // ★ cwi-final S6-5：ok = db && redis && worker（heartbeat <120s）&& lag（inbound oldest <60s）
  const ok = db === "ok" && redis === "ok" && worker.workerOk && lag.lagOk;
  if (!ok) {
    log.warn({ ...body }, "healthz: degraded");
  }
  const status = ok ? 200 : 503;

  // S3-9 token gate：公開只回 { ok }（liveness）；詳細（security flags / queue）要 ?token
  const tokenCfg = process.env.HEALTHZ_TOKEN ?? "";
  const provided = req.nextUrl.searchParams.get("token") ?? "";
  if (tokenCfg) {
    if (provided) {
      if (provided !== tokenCfg) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return NextResponse.json(body, { status });
    }
    return NextResponse.json({ ok }, { status });
  }
  // gate 停用（HEALTHZ_TOKEN 未設）— dev 便利：直接詳細 body
  return NextResponse.json(body, { status });
}
