/**
 * e2e-socket — T42 用嘅 Socket.IO 客戶端（P0-3：停用帳號即時斷線斷言）。
 *
 * 用法：pnpm e2e:socket --cookie "wa_inbox_session=<value>" [--wait-ms 20000]
 *
 * 輸出（shell grep 斷言用）：
 *   SOCKET-CONNECTED            — 認證通過，connect 成功
 *   SOCKET-DISCONNECTED <reason> — 被斷線（admin 停用 → disconnectSockets）
 *   SOCKET-ERROR <msg>          — 認證被拒（fail-closed 驗證用）
 *
 * Exit code：
 *   0 = 收到 disconnect（斷言成功）
 *   1 = 一直連住直到 timeout（斷言失敗）
 *   2 = connect 被拒 / 錯誤
 */
import { io } from "socket.io-client";

const args = process.argv.slice(2);
const cookie = args[args.indexOf("--cookie") + 1] ?? "";
const waitMs = Number(args[args.indexOf("--wait-ms") + 1] ?? 20000);
const port = process.env.PORT ?? "3100";

if (!cookie) {
  console.error("missing --cookie \"wa_inbox_session=...\"");
  process.exit(2);
}

const socket = io(`http://127.0.0.1:${port}`, {
  // ★ 必須用 websocket transport：Node 下 socket.io polling 走 xmlhttprequest-ssl，
  //   佢跟 browser 規格把 `Cookie` 列為 forbidden header → setRequestHeader 被靜默丟 →
  //   server 收唔到 session cookie → middleware reject → "xhr post error"（E2E T42 捉住）。
  //   websocket upgrade 經 `ws` package，extraHeaders 原樣送出 → cookie 到位。
  transports: ["websocket"],
  extraHeaders: { Cookie: cookie },
  timeout: 8000,
  reconnection: false, // 被拒/被斷唔好自動重連（斷言要睇到第一手結果）
});

const timer = setTimeout(() => {
  console.error("SOCKET-TIMEOUT still connected（未被斷線）");
  process.exit(1);
}, waitMs);

socket.on("connect", () => {
  console.log("SOCKET-CONNECTED");
});
socket.on("connect_error", (err) => {
  console.error(`SOCKET-ERROR ${err.message}`);
  process.exit(2);
});
socket.on("disconnect", (reason) => {
  clearTimeout(timer);
  console.log(`SOCKET-DISCONNECTED ${reason}`);
  process.exit(0);
});
