import type { Server as SocketIOServer, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { getSocketSession, type SessionData } from "@/lib/session";
import { resolveSessionScope } from "@/lib/rbac";
import { isStaffActive, invalidateActiveCache, invalidateStaffSessions, isStaffSessionCurrent, isSessionDenied } from "@/lib/rbac";
import { CONTROL_CHANNEL, type ControlMessage, bustScopeCache } from "@/lib/notify";
import { applyCacheBust } from "@/lib/cache-bust";
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
 * - ★ P0-3：session 有效之後再核 StaffUser.active（同 web API 同一個 isStaffActive
 *   check + 60s cache）→ 停用 → reject
 * - ★ 唔信 client handshake.auth 聲稱嘅任何嘢 — room 成員資格 100% 由
 *   server 端驗證後嘅 session 決定
 * - ★ 停用即時斷線：disconnectStaff(staffId) 由 admin 停用 route 調用
 *   （io.disconnectSockets 語義 — 強制斷已連 socket）
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

/** staffId → 而家已連嘅 socketId 集合（停用時精準斷線用）。 */
const staffSockets = new Map<string, Set<string>>();

/** ★ cwi-final S3-2（A1）：sid → 已連 socketId 集合（登出當前機時精準斷呢個 session 嘅 socket；
 * 其他機嘅 socket 唔受影響）。舊 session 冇 sid → 唔喺呢個 map（只受 staff 層斷線影響）。 */
const sidSockets = new Map<string, Set<string>>();

export function initHub(io: SocketIOServer): void {
  state.io = io;

  // ── Auth middleware：驗 session + 核 active 先准 connect ─────────────
  io.use(async (socket: Socket, next) => {
    try {
      const session = await getSocketSession(socket.request);
      if (!session) {
        return next(new Error("unauthorized"));
      }
      // ★ P0-3：停用帳號即時擋（同 web API 同一個 isStaffActive check + 60s cache）
      if (!(await isStaffActive(session.staffId))) {
        log.warn({ staffId: session.staffId }, "socket: connect rejected (account disabled)");
        return next(new Error("account disabled"));
      }
      // ★ C-3 尾批：password reset 後嘅舊 session → 拒絕新連（同 web API 401 同水位）
      if (!(await isStaffSessionCurrent(session))) {
        log.warn({ staffId: session.staffId }, "socket: connect rejected (session invalidated)");
        return next(new Error("session invalidated"));
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
    // ★ PII 鐵律：只 log metadata（staffId / clinicId / role + socketId 尾段）
    log.info(
      { staffId: session.staffId, clinicId: session.clinicId, role: session.role },
      "socket connected (authenticated)"
    );

    // 記錄 staffId → socketId（停用時 disconnectStaff 精準斷線）
    let ids = staffSockets.get(session.staffId);
    if (!ids) {
      ids = new Set();
      staffSockets.set(session.staffId, ids);
    }
    ids.add(socket.id);
    // ★ cwi-final S3-2（A1）：sid → socketId（登出時 disconnectSession 精準斷）
    if (session.sid) {
      let sids = sidSockets.get(session.sid);
      if (!sids) {
        sids = new Set();
        sidSockets.set(session.sid, sids);
      }
      sids.add(socket.id);
    }
    // ★ H2：per-staff room — notify:mention 定向推送用（只 @ 中嗰個人收）
    void socket.join(`staff:${session.staffId}`);
    // ★ 診斷（P0-3 sockets:0 排查）：註冊後 log 實際 map 狀態
    log.info(
      {
        staffId: session.staffId,
        socketId: socket.id.slice(-8),
        registered: staffSockets.get(session.staffId)?.size ?? -1,
        mapStaffs: staffSockets.size,
      },
      "socket registered in staffSockets"
    );

    if (session.role === "STAFF") {
      // ★ cwi-hub-a-20260914：單一 funnel resolveSessionScope（CLINICS = session 綁定店集合 +
      //   舊 session fallback；COMPANY scope STAFF = 該公司 clinic rooms — 同列表 scope 一致）。
      void resolveSessionScope(session)
        .then(({ scopedClinicIds }) =>
          Promise.all(scopedClinicIds.map((cid) => socket.join(`clinic:${cid}`)))
        )
        .catch((err) =>
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "socket: staff room join failed")
        );
    } else if (session.role === "ADMIN" || session.role === "SUPERVISOR") {
      // ★ cwi-hub-a-20260914（Part A）：通知跟 scope（鐵律）— ALL scope / SUPERVISOR join 全部店；
      //   COMPANY scope ADMIN 只 join 自己公司嘅 clinic room（30s cache + clinic 改動即時失效）。
      void resolveSessionScope(session)
        .then(({ scopedClinicIds }) =>
          Promise.all(scopedClinicIds.map((cid) => socket.join(`clinic:${cid}`)))
        )
        .catch((err) =>
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "socket: admin room join failed")
        );
    }

    socket.on("disconnect", (reason) => {
      log.debug({ staffId: session.staffId, reason }, "socket disconnected");
      const set = staffSockets.get(session.staffId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) staffSockets.delete(session.staffId);
      }
      // ★ A1：sid 映射同步清（登出斷線 / 自然斷線都係）
      if (session.sid) {
        const sset = sidSockets.get(session.sid);
        if (sset) {
          sset.delete(socket.id);
          if (sset.size === 0) sidSockets.delete(session.sid);
        }
      }
    });

    // ★ cwi-inboxfix-20260905（MD I-10）：顯式重註冊 — client 喺 connect/reconnect 時 emit "register"。
    //   常規註冊已喺 connection 時自動做（auth middleware）；呢個 handler 係冪等雙保險
    //   （重 join room + staffSockets 重複 add 無害）— 防未來自動路徑被改動，
    //   並提供「socket registered (explicit)」log 線（驗收 grep 用）。
    socket.on("register", () => {
      const s = socket.data.session as SessionData;
      if (!s) return;
      let ids = staffSockets.get(s.staffId);
      if (!ids) {
        ids = new Set();
        staffSockets.set(s.staffId, ids);
      }
      ids.add(socket.id);
      void socket.join(`staff:${s.staffId}`);
      if (s.role === "STAFF") {
        // ★ cwi-hub-a-20260914：scope-aware（同 connection 分支）— 單一 funnel
        void resolveSessionScope(s)
          .then(({ scopedClinicIds }) =>
            Promise.all(scopedClinicIds.map((cid) => socket.join(`clinic:${cid}`)))
          )
          .catch((err) =>
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "socket: explicit register staff room join failed")
          );
      } else {
        // ★ cwi-hub-a-20260914：scope-aware（同 connection 分支）— ALL/SUPERVISOR 全店；COMPANY 只自己公司
        void resolveSessionScope(s)
          .then(({ scopedClinicIds }) =>
            Promise.all(scopedClinicIds.map((cid) => socket.join(`clinic:${cid}`)))
          )
          .catch((err) =>
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "socket: explicit register admin room join failed")
          );
      }
      log.info({ staffId: s.staffId, socketId: socket.id.slice(-8) }, "socket registered (explicit)");
    });
  });

  // ── ★ cwi-final S3-2（A1）：60s 週期重驗（fail-closed 兜底）──────────────────
  // socket 連上之後，若該 session 被 deny（登出）/ 被 cutoff（password reset）/ staff 被停用，
  // 正常路徑係 control channel 即時斷線；呢度係 60s 兜底（Redis 死 / 斷線指令丟失時）。
  // unref() — timer 唔會拖住 process 退出。
  const revalidateTimer = setInterval(() => {
    void (async () => {
      const io = state.io;
      if (!io) return;
      for (const [staffId, ids] of [...staffSockets.entries()]) {
        let staffOk = false;
        try {
          staffOk = await isStaffActive(staffId);
        } catch {
          staffOk = false; // fail-closed：查唔到 → 斷（同 middleware 一致）
        }
        if (!staffOk) {
          const n = disconnectStaff(staffId);
          if (n > 0) log.info({ staffId, sockets: n }, "socket: revalidate → staff disabled, disconnected");
          continue;
        }
        // ★ socket.io v4：io.sockets 類型唔暴露迭代 — 用官方 io.in(ids).fetchSockets()
        //   （只回傳而家仲連緊嘅 socket — staffSockets 殘留嘅已斷 id 自然過濾）
        try {
          const live = await io.in([...ids]).fetchSockets();
          for (const socket of live) {
            const session = socket.data.session as SessionData | undefined;
            let ok = true;
            if (!session) {
              ok = false; // 冇 session 元數據（唔應該發生）→ fail-closed 斷
            } else {
              try {
                if (!(await isStaffSessionCurrent(session))) ok = false;
                else if (await isSessionDenied(session.sid)) ok = false;
              } catch {
                ok = false; // fail-closed：檢查拋錯 → 斷（重連時 middleware 會重驗）
              }
            }
            if (!ok) {
              log.info({ staffId, socketIdTail: socket.id.slice(-8) }, "socket: revalidate failed → disconnected");
              socket.disconnect(true);
            }
          }
        } catch (err) {
          log.warn({ staffId, err: err instanceof Error ? err.message : String(err) }, "socket: revalidate fetchSockets failed");
        }
      }
    })().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "socket: revalidate pass failed");
    });
  }, 60_000);
  revalidateTimer.unref?.();
}

/**
 * Control bridge（P0-3）：訂閱 Redis control channel — 由「真正持 io 呢份 module
 * instance」去執行停用後果（斷 socket + 失效本地 active cache）。
 *
 * 點解必須獨立橋：API route handler 同 server.ts 各持一份 hub.ts/rbac.ts module
 * instance（不同 module graph / require cache）— route 側 invalidate 只影響 route
 * 世界，socket middleware 世界要經呢度先收得到。PM2 cluster 模式下仲負責跨 node。
 * @param sub 獨立 Redis connection（subscribe 會独占 connection，必须 duplicate）
 */
export function initControlBridge(sub: Redis): void {
  sub.on("error", (err) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "control subscriber error");
  });
  sub.subscribe(CONTROL_CHANNEL, (err) => {
    if (err) log.error({ err: err.message }, "control subscribe failed");
  });
  sub.on("message", (_channel, msg) => {
    try {
      const data = JSON.parse(msg) as ControlMessage;
      if (data.cmd === "staff:changed") {
        // 本 instance（socket middleware 用嘅嗰份）cache 即時失效
        invalidateActiveCache(data.staffId);
        if (!data.active) {
          const n = disconnectStaff(data.staffId);
          log.info({ staffId: data.staffId, sockets: n }, "control: staff:changed(disabled) applied");
        }
      } else if (data.cmd === "staff:sessions-invalidated") {
        // ★ C-3 尾批：password reset — 本 instance 設 cutoff（新連被擋）+ 斷晒已連 socket
        // （async — local 先設，Redis 持久化失敗只 warn 唔阻斷線）
        void invalidateStaffSessions(data.staffId).catch((err) => {
          log.warn(
            { staffId: data.staffId, err: err instanceof Error ? err.message : String(err) },
            "control: cutoff 持久化失敗（local 已設）"
          );
        });
        const n = disconnectStaff(data.staffId);
        log.info({ staffId: data.staffId, sockets: n }, "control: staff:sessions-invalidated applied (password reset)");
      } else if (data.cmd === "cache:bust") {
        // ★ Fix B（cwi-fix-20260825-f1）：web process 側 automation/workflow cache 即時失效
        applyCacheBust(data.scope);
      } else if (data.cmd === "scope:changed") {
        // ★ cwi-final S1-4：staff 範圍/技能組改動 → 清本 instance 嘅 publishConvEvent scope cache
        bustScopeCache();
      } else if (data.cmd === "availability:busted") {
        // ★ cwi-refresh-20260831 §3：availability L2 該日 busted + 重填完 → 推 clinic room 俾 UI 即時重繪
        // （payload 零 PII：clinicCode/date 都係營運元數據）
        notifyClinic(data.clinicId, "availability:busted", { clinicCode: data.clinicCode, date: data.date });
      } else if (data.cmd === "session:denied") {
        // ★ cwi-final S3-2（A1）：登出當前機 → 只斷呢個 sid 嘅 socket（其他機唔受影響）
        const n = disconnectSession(data.sid);
        log.info({ sidTail: data.sid.slice(-6), sockets: n }, "control: session:denied applied (logout current machine)");
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "control: bad message ignored"
      );
    }
  });
}

/**
 * 強制斷指定 staff 嘅所有已連 socket（admin 停用帳號時調用 — P0-3）。
 * @returns 斷咗幾多 socket
 */
export function disconnectStaff(staffId: string): number {
  const io = state.io;
  const ids = staffSockets.get(staffId);
  // ★ 診斷（P0-3 sockets:0 排查）：入參 vs 實際 map 狀態（staffId 尾段 only — 無 PII）
  log.info(
    {
      staffIdTail: staffId.slice(-6),
      hasIo: !!io,
      registered: ids ? ids.size : -1,
      mapStaffs: [...staffSockets.keys()].map((k) => k.slice(-6)),
    },
    "disconnectStaff called"
  );
  if (!io || !ids || ids.size === 0) return 0;
  // ★ 先讀 count 先斷線：socket.io v4 嘅 disconnectSockets(true) 會「同步」觸發各 socket 嘅
  //   'disconnect' event → 我哋自己嘅 disconnect handler 會即刻清走 staffSockets →
  //   若喺斷線之後先讀 ids.size，會永遠讀到 0（仲以為冇斷到）。
  const n = ids.size;
  // socket.io v4：每個 socket 自動 join 一個以自己 socketId 做名嘅 room →
  // io.in([...ids]) 就係精確呢組 socket；disconnectSockets(true) = 強制斷（MD 指定 API）。
  io.in([...ids]).disconnectSockets(true);
  staffSockets.delete(staffId);
  if (n > 0) log.info({ staffId, sockets: n }, "socket: staff disconnected (account disabled)");
  return n;
}

/**
 * ★ cwi-final S3-2（A1）：強制斷指定 session（sid）嘅所有已連 socket（登出當前機時經
 * control channel `session:denied` 調用）。同 disconnectStaff 同 pattern：先讀 count 先斷線。
 * @returns 斷咗幾多 socket
 */
export function disconnectSession(sid: string): number {
  const io = state.io;
  const ids = sidSockets.get(sid);
  if (!io || !ids || ids.size === 0) return 0;
  const n = ids.size;
  io.in([...ids]).disconnectSockets(true);
  sidSockets.delete(sid); // disconnect handler 會同步再清一次（冪等）
  if (n > 0) log.info({ sidTail: sid.slice(-6), sockets: n }, "socket: session disconnected (logout)");
  return n;
}

/** 推去單一店嘅 room。 */
export function notifyClinic(clinicId: string, event: string, payload: unknown): void {
  state.io?.to(`clinic:${clinicId}`).emit(event, payload);
}

/** ★ H2：推去單一 staff 嘅所有 socket（`staff:{staffId}` room；notify:mention 定向通知）。 */
export function notifyStaff(staffId: string, event: string, payload: unknown): void {
  state.io?.to(`staff:${staffId}`).emit(event, payload);
}
