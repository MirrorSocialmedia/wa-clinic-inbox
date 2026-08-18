import { createServer, type IncomingMessage, type ServerResponse } from "http";
import next from "next";
import { Server } from "socket.io";
import { initHub } from "@/sockets/hub";
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

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const start = Date.now();
    // 只 log 請求 metadata（method / path / status / ms），body 永遠唔入 log
    res.on("finish", () => {
      const ms = Date.now() - start;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      (log[level] as (obj: object, msg?: string) => void)(
        { method: req.method, path: req.url, status: res.statusCode, ms },
        "request"
      );
    });
    void handle(req, res);
  });

  server.listen(port, () => {
    log.info({ port, dev }, "wa-clinic-inbox server ready");
  });
});
