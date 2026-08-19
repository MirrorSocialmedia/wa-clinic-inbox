import "@/lib/als-polyfill"; // 必須係第一行 import — 見該檔註釋
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import next from "next";
import { Server } from "socket.io";
import { initHub, initControlBridge, notifyClinic } from "@/sockets/hub";
import { getRedis, closeRedis } from "@/lib/queue";
import { NOTIFY_CHANNEL, type NotifyMessage } from "@/lib/notify";
import { bootMediaSecurityCheck } from "@/lib/wa/media";
import { bootKeyPathCheck } from "@/lib/boot-key-paths";
import log from "@/lib/log";

/**
 * WA Clinic Inbox — custom server（框架 MD §1/§3）
 *
 * Next.js 15 + Socket.IO 掛同一個 port（預設 3100）：
 * - /socket.io/* → Socket.IO（handshake + websocket upgrade）
 * - 其他         → Next.js（pages / API routes）
 *
 * dev : pnpm dev   → tsx server.ts（NODE_ENV !== production → next dev）
 * prod: pnpm start → tsx server.ts（next start 模式）
 */

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3100", 10);

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer();

  // Socket.IO：只攞 /socket.io path 嘅 request + upgrade，其他全部 fall through 畀 Next
  const io = new Server(server, {
    path: "/socket.io",
    // 同源部署（nginx 反代）；跨域需要時設 SOCKET_CORS_ORIGIN
    cors: process.env.SOCKET_CORS_ORIGIN
      ? { origin: process.env.SOCKET_CORS_ORIGIN }
      : undefined,
    // 唔存 query string / cookie 入 log（PII）
    transports: ["websocket", "polling"],
  });
  initHub(io);

  // 安全審計 C-1 boot assertion：production 未設 DISK_ENCRYPTED / media dir 唔可用 →
  // 開機即 log ERROR（唔准「未加密碟」靜默上線）；dev 明文 media 亦會響亮提示。
  void bootMediaSecurityCheck().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "boot: media security check failed");
  });

  // 安全審計 M-6：production 金鑰路徑 boot 警報（私匙路徑喺 repo working dir 內 → 醒目 WARN）
  try {
    bootKeyPathCheck();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "boot: key path check failed");
  }

  // Redis pub/sub 橋：worker process 處理完 webhook 後 publish 通知，
  // 呢度 subscribe 並 emit 去對應 clinic room（見 lib/notify.ts）。
  // 用 duplicate() 開獨立 connection（subscribe 會独占個 connection）。
  const notifySub = getRedis().duplicate();
  notifySub.on("error", (err) => {
    log.warn({ err: err.message }, "notify subscriber error");
  });
  notifySub.subscribe(NOTIFY_CHANNEL, (err) => {
    if (err) log.error({ err: err.message }, "notify subscribe failed");
  });
  notifySub.on("message", (_channel, msg) => {
    try {
      const data = JSON.parse(msg) as NotifyMessage;
      notifyClinic(data.clinicId, data.event, data.payload);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "notify: bad message ignored"
      );
    }
  });

  // P0-3 control bridge：admin 停用 → Redis → 呢個 process（持 io）斷 socket。
  // 必須喺呢度訂閱（而唔係 API route 直接調 disconnectStaff）— 見 hub.ts 註釋。
  const controlSub = getRedis().duplicate();
  initControlBridge(controlSub);

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    // ★ /socket.io/* 由 Socket.IO（initHub）處理 — Next handler 唔准攞：
    //   雙 handler 對同一 response 搶寫 → 308 redirect / ERR_HTTP_HEADERS_SENT 競態
    //   （E2E T42 捉住：polling POST 被 Next 308 走，client "xhr post error"）。
    if ((req.url ?? "").startsWith("/socket.io")) return;
    const start = Date.now();
    // 只 log 請求 metadata（method / path / status / ms），body 永遠唔入 log。
    // ★ path 只留 pathname — query string 可能含 token（e.g. webhook GET 驗證嘅
    //   hub.verify_token = WA_VERIFY_TOKEN），入 log 就係 secret leak。
    res.on("finish", () => {
      const ms = Date.now() - start;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      (log[level] as (obj: object, msg?: string) => void)(
        {
          method: req.method,
          path: (req.url ?? "").split("?")[0],
          status: res.statusCode,
          ms,
        },
        "request"
      );
    });
    void handle(req, res);
  });

  server.listen(port, () => {
    log.info({ port, dev }, "wa-clinic-inbox server ready");
  });

  // Graceful shutdown（PM2 stop → SIGINT / kill → SIGTERM）：
  // 先切 Socket.IO（disconnect 所有 client），再 stop 接新 request、等 in-flight 完成，
  // 最後 close Redis 先 exit。5s drain 唔完就 force exit（PM2 kill_timeout 8s）。
  let shuttingDown = false;
  function gracefulShutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "wa-clinic-inbox shutting down");
    io.close();
    notifySub.quit().catch(() => notifySub.disconnect());
    controlSub.quit().catch(() => controlSub.disconnect());
    server.close(() => {
      void closeRedis().catch(() => undefined).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
});
