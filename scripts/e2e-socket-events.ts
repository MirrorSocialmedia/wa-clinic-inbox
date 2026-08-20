/**
 * e2e-socket-events — H1 e2e 用嘅 Socket.IO 事件捕手。
 *
 * 用法：pnpm e2e:socket-events --cookie "wa_inbox_session=<value>" [--wait-ms 30000]
 *
 * 輸出（shell grep 斷言用）：
 *   SOCKET-CONNECTED              — 認證通過
 *   SOCKET-EVENT conversation:assigned <json>
 *   SOCKET-EVENT note:new <json>
 *   SOCKET-EVENT <其他事件> <json>   — 一併 log（除咗 message:new 內文欄位唔打）
 *
 * Exit code：0 = timeout 正常結束（捕夠時間）；2 = connect 被拒
 *
 * ★ PII 鐵律：socket payload 本身零內文（server 端保證）；呢度直接 JSON.stringify
 *   整包 — 就算 message:new 入嚟都只係 metadata（message 體喺 DB，event 只有 pointer）。
 */
import { io } from "socket.io-client";

const args = process.argv.slice(2);
const cookie = args[args.indexOf("--cookie") + 1] ?? "";
const waitMs = Number(args[args.indexOf("--wait-ms") + 1] ?? 30000);
const port = process.env.PORT ?? "3100";

if (!cookie) {
  console.error("missing --cookie \"wa_inbox_session=...\"");
  process.exit(2);
}

const socket = io(`http://127.0.0.1:${port}`, {
  // 同 e2e-socket.ts：websocket transport 先送得到 cookie（polling 會丢）
  transports: ["websocket"],
  extraHeaders: { Cookie: cookie },
  timeout: 8000,
  reconnection: false,
});

setTimeout(() => {
  console.log("SOCKET-EVENTS-DONE");
  process.exit(0);
}, waitMs);

socket.on("connect", () => {
  console.log("SOCKET-CONNECTED");
});
socket.on("connect_error", (err) => {
  console.error(`SOCKET-ERROR ${err.message}`);
  process.exit(2);
});
socket.onAny((event: string, payload: unknown) => {
  let body = "";
  try {
    body = JSON.stringify(payload ?? {});
  } catch {
    body = "<unserializable>";
  }
  // message:new 可能帶完整 message 對象（內文喺度）— 只打 metadata 欄位
  if (event === "message:new") {
    const p = (payload ?? {}) as Record<string, any>;
    body = JSON.stringify({
      conversationId: p.conversationId,
      clinicId: p.clinicId,
      direction: p.message?.direction,
      channel: p.message?.channel,
      messageId: p.message?.id,
    });
  }
  console.log(`SOCKET-EVENT ${event} ${body}`);
});
