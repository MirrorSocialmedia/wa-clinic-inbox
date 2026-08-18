import type { Server as SocketIOServer } from "socket.io";
import log from "@/lib/log";

/**
 * Socket.IO hub — 實時推去 inbox（框架 MD §1/§6.4）
 *
 * Room 模型：
 * - STAFF 登入後 join `clinic:{clinicId}`（只自己店）
 * - ADMIN join 全部店嘅 room
 * - event: message:new / draft:ready / conv:status / booking:new ...（Phase 1/2 填實）
 *
 * Phase 0-C skeleton：handshake 只收 placeholder claim，
 * Phase 1 換做 session 驗證（同 rbac.ts 同一個 iron-session cookie）。
 */

interface HubState {
  io: SocketIOServer | null;
}

const state: HubState = { io: null };

export interface HandshakeAuth {
  /** Phase 1：由 iron-session cookie 換出嘅 claim（而家係 placeholder，唔做驗證） */
  staffId?: string;
  clinicId?: string | null;
  role?: "ADMIN" | "STAFF";
}

export function initHub(io: SocketIOServer): void {
  state.io = io;

  io.on("connection", (socket) => {
    const auth = (socket.handshake.auth ?? {}) as HandshakeAuth;
    // ★ PII 鐵律：只 log metadata（staffId / clinicId），唔 log 任何 session 內容
    log.info(
      { staffId: auth.staffId ?? null, clinicId: auth.clinicId ?? null },
      "socket connected"
    );

    // Phase 1：驗 session 先准 join。Skeleton 只 join handshake 聲稱嘅 room。
    if (auth.role === "STAFF" && auth.clinicId) {
      void socket.join(`clinic:${auth.clinicId}`);
    } else if (auth.role === "ADMIN") {
      // Phase 1：ADMIN join 全部已知 clinic room（由 DB 列出）
      void socket.join("admin-all");
    }

    socket.on("disconnect", (reason) => {
      log.debug({ staffId: auth.staffId ?? null, reason }, "socket disconnected");
    });
  });
}

/** 推去單一店嘅 room。 */
export function notifyClinic(
  clinicId: string,
  event: string,
  payload: unknown
): void {
  state.io?.to(`clinic:${clinicId}`).emit(event, payload);
}

/** 推去全部店（admin-all + 每間 clinic room；Phase 1 填實 room 列表）。 */
export function notifyAll(event: string, payload: unknown): void {
  state.io?.to("admin-all").emit(event, payload);
}
