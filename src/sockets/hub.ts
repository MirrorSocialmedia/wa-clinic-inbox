import type { Server as SocketIOServer, Socket } from "socket.io";
import prisma from "@/lib/prisma";
import { getSocketSession, type SessionData } from "@/lib/session";
import log from "@/lib/log";

/**
 * Socket.IO hub — 實時推去 inbox（框架 MD §1/§6.4 + Phase 0-C 自審 P2 項 1）
 *
 * Room 模型：
 * - STAFF 登入後 join `clinic:{clinicId}`（只自己店）
 * - ADMIN join 全部店嘅 room
 *
 * AUTH（Phase 1 填實）：
 * - connect 前經 io.use middleware 驗 iron-session cookie（同 web API 同一個
 *   加密 cookie，unsealData 內置 tamper + ttl 檢查）
 * - 驗唔到 session → reject（fail-closed）
 * - ★ 唔信 client handshake.auth 聲稱嘅任何嘢 — room 成員資格 100% 由
 *   server 端驗證後嘅 session 決定
 *
 * 事件（由 worker 經 Redis pub/sub 橋轉送，見 lib/notify.ts）：
 * - message:new      新訊息（inbound / echo / outbound 發完）
 * - message:status   status tick 更新（sent/delivered/read/failed）
 * - conv:updated     對話狀態/assignee 改動
 */

interface HubState {
  io: SocketIOServer | null;
}

const state: HubState = { io: null };

export function initHub(io: SocketIOServer): void {
  state.io = io;

  // ── Auth middleware：驗 session 先准 connect ─────────────────────────
  io.use(async (socket: Socket, next) => {
    try {
      const session = await getSocketSession(socket.request);
      if (!session) {
        return next(new Error("unauthorized"));
      }
      socket.data.session = session;
      next();
    } catch (err) {
      // 驗簽過程任何異常 → reject（fail-closed）
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "socket: auth check error, rejecting"
      );
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const session = socket.data.session as SessionData;
    // ★ PII 鐵律：只 log metadata（staffId / clinicId / role）
    log.info(
      { staffId: session.staffId, clinicId: session.clinicId, role: session.role },
      "socket connected (authenticated)"
    );

    if (session.role === "STAFF") {
      // STAFF 硬性綁自己店
      void socket.join(`clinic:${session.clinicId}`);
    } else if (session.role === "ADMIN") {
      // ADMIN join 全部已知 clinic room
      void prisma
        .clinic.findMany({ select: { id: true } })
        .then((clinics) =>
          Promise.all(clinics.map((c) => socket.join(`clinic:${c.id}`)))
        )
        .catch((err) =>
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "socket: admin room join failed")
        );
    }

    socket.on("disconnect", (reason) => {
      log.debug({ staffId: session.staffId, reason }, "socket disconnected");
    });
  });
}

/** 推去單一店嘅 room。 */
export function notifyClinic(clinicId: string, event: string, payload: unknown): void {
  state.io?.to(`clinic:${clinicId}`).emit(event, payload);
}
