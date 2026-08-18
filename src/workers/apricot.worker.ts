/**
 * Apricot worker — ★ 所有 Apricot HTTP request 嘅唯一執行通道
 *
 * concurrency=1 = 嚴格序列化（MD §8.1）：同一時間只有一個 Apricot request 行緊，
 * 防兩個 request 同時 rotation 互相炒車 token。sync-clinic / keepalive / 手動
 * refresh 全部入呢個 queue 排隊。
 *
 * Job names:
 * - sync-clinic   { clinicId }      同步單店空檔（手動 refresh）
 * - sync-all      { reason? }       同步全站（cron sync-availability 觸發）
 * - keepalive     {}                輕量 request（每 3 日 — 令 token 保持新鮮）
 *
 * ★ 鐵律：其他地方一律唔准直接 call apricotCall() — 只可以 enqueue。
 */
import { Worker } from "bullmq";
import { apricotQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import log from "@/lib/log";
import { apricotMock, markError, loadCreds, saveCreds, ensureMockSession } from "@/lib/apricot/session";
import { apricotCall } from "@/lib/apricot/client";
import { syncClinic, syncAllClinics } from "@/lib/apricot/slots";

export async function startApricotWorker(): Promise<Worker | null> {
  const worker = new Worker(
    apricotQueue.name,
    async (job) => {
      switch (job.name) {
        case "sync-clinic": {
          const { clinicId } = job.data as { clinicId: string };
          const r = await syncClinic(clinicId);
          return { ok: true, ...r };
        }
        case "sync-all": {
          const results = await syncAllClinics();
          return { ok: true, clinics: results.length };
        }
        case "keepalive": {
          if (apricotMock()) {
            // mock：冇真 endpoint — 只更新 heartbeat metadata
            const creds = (await loadCreds()) ?? (await ensureMockSession());
            await saveCreds(creds, { lastKeepaliveAt: new Date(), rotate: false });
            log.info({ mock: true }, "apricot: keepalive ok（mock）");
            return { ok: true, mock: true };
          }
          // real：輕量 GET（keepalive path 可配；預設 / = 攞 cookie rotation）
          const path = process.env.APRICOT_KEEPALIVE_PATH || "/";
          await apricotCall(path);
          const creds = await loadCreds();
          if (creds) await saveCreds(creds, { lastKeepaliveAt: new Date(), rotate: false });
          log.info({}, "apricot: keepalive ok");
          return { ok: true, mock: false };
        }
        default:
          log.warn({ jobName: job.name }, "apricot worker: unknown job — skip");
      }
    },
    {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      // ★★ 嚴格序列化 — 防 token rotation 炒車
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    log.info({ job: job.name, id: job.id }, "apricot: job ok");
  });
  worker.on("failed", async (job, err) => {
    // auth 失效 / rate limit 唔值得 retry（client 已標記）— 一律記 metadata
    const msg = err.message ?? String(err);
    log.error({ job: job?.name, err: msg }, "apricot: job failed");
    if (msg === "APRICOT_AUTH_EXPIRED" || msg === "APRICOT_RATE_LIMITED") {
      await markError(`${job?.name}: ${msg}`);
    }
  });

  log.info({}, "apricot worker started (concurrency=1)");
  return worker;
}

/**
 * enqueue helper（caller 用呢個）— 經 shared apricotQueue（同 prefix）。
 * ★ 鐵律：其他地方一律唔准直接 call apricotCall() — 只可以 enqueue。
 */
export async function enqueueApricot(name: "sync-clinic" | "sync-all" | "keepalive", data: Record<string, unknown> = {}) {
  const res = await apricotQueue.add(name, data);
  return res.id;
}
