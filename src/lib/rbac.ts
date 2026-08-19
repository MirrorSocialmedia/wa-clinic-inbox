import { type NextRequest } from "next/server";
import { getSession, type SessionData } from "@/lib/session";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getRedis } from "@/lib/queue";

/**
 * WA Clinic Inbox — RBAC 基礎（框架 MD D10 / §6.4）
 *
 * 權限模型：
 * - ADMIN  → 跨店（clinicId = null，可睇全部店）
 * - STAFF  → 只自己店（clinicId 硬性綁定；每條 query 都要帶 clinicId = session.clinicId，
 *            唔靠前端收埋）
 *
 * 用法（App Router route handler）：
 *   const { staff, clinicId, res } = await requireAuth(req);
 *   const rows = await prisma.conversation.findMany({ where: clinicScope({ role, clinicId }) });
 *   ...
 *   return next(res)  // 或將 res 嘅 set-cookie header 帶落自己個 response
 *
 * 例外（唔經 RBAC）：/api/wa/webhook（Meta 簽名驗證）、/api/flows/endpoint（RSA 加密驗證）、
 * /healthz（monitoring）。
 *
 * ★ 即時停用（P0-3）：session 係 iron-session snapshot（TTL 7 日）— 停用帳號後 session 會
 *   喺 cookie 到期前都有效。requireAuth 喺 getSession 之後核 StaffUser.active（+60s
 *   in-memory cache 免每 request 打 DB）→ 停用 → 401 "account disabled"。
 *   Socket 側（hub.ts）connect 前過同一個 check；admin 停用時另加 disconnectSockets
 *   強制斷已連 socket（見 admin/staff route）。
 */

export interface StaffInfo {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "STAFF";
}

export interface AuthContext {
  staff: StaffInfo;
  /** STAFF = 綁定店；ADMIN = null（跨店） */
  clinicId: string | null;
  /** 必需要將呢個 response（或其 set-cookie header）帶返畀 client */
  res: Awaited<ReturnType<typeof getSession>>["res"];
}

export class RbacError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "RbacError";
  }
}

/**
 * 即時停用檢查（P0-3）：StaffUser.active，+60s in-memory cache 免每 request 打 DB。
 * - web API（requireAuth）同 Socket.IO（hub connect）共用同一個 check + 同一份 cache
 *   （兩者都喺 web server process 內）。
 * - admin 停用帳號時叫 `invalidateActiveCache(staffId)` 即時失效（唔使等 60s）。
 * - fail-closed：DB 查唔到 / 查詢失敗 → 當停用（寧錯殺，唔漏放 — 離職員工睇病人對話
 *   係私隱事故級數）。cache 命中時唔打 DB。
 */
const ACTIVE_CACHE_TTL_MS = 60_000;
const activeCache = new Map<string, { active: boolean; at: number }>();

export async function isStaffActive(staffId: string): Promise<boolean> {
  const now = Date.now();
  const hit = activeCache.get(staffId);
  if (hit && now - hit.at < ACTIVE_CACHE_TTL_MS) return hit.active;
  let active = false;
  try {
    const u = await prisma.staffUser.findUnique({ where: { id: staffId }, select: { active: true } });
    active = u?.active ?? false;
  } catch (err) {
    log.error(
      { staffId, err: err instanceof Error ? err.message : String(err) },
      "rbac: active check DB error — fail-closed（當停用）"
    );
    active = false;
  }
  activeCache.set(staffId, { active, at: now });
  // 順手清舊 entry（staff 數極少；防 map 無限長）
  if (activeCache.size > 1000) {
    for (const [k, v] of activeCache) if (now - v.at >= ACTIVE_CACHE_TTL_MS * 2) activeCache.delete(k);
  }
  return active;
}

/** admin 改咗帳號狀態時叫 — 停用即時生效（唔使等 60s cache 到期）。 */
export function invalidateActiveCache(staffId: string): void {
  activeCache.delete(staffId);
}

// ── C-3 尾批：reset password 踢 session（loginAt cutoff） ─────────────────────────
// iron-session 係 stateless sealed cookie — 冇 server-side session store 可以刪。
// 做法：per-staff cutoff 時間戳；loginAt < cutoff 嘅 session 一律當失效：
//   - web API：requireAuth 下一 request 即刻 401（同停用同水位）
//   - socket：hub connect 擋新連 + 已連 socket 由 control bridge kick（disconnectStaff）
// 雙層持久化（Batch B M4 加固）：
//   1) in-memory Map — 同 process 快路徑（即刻生效）
//   2) Redis sess-cutoff:{staffId}（TTL 86400s = session TTL 上限）— 補住純 memory Map 三個缺口：
//      dev 模式 module 多副本（Next dev 每個 route 各編譯一份 lib → Map 唔共享）、
//      多 instance、process 重啟（reset 完 PM2 restart → 舊 session 即刻復活）。
const sessionCutoffs = new Map<string, number>(); // staffId → cutoff epoch ms
const SESS_CUTOFF_PREFIX = "sess-cutoff:";
const SESS_CUTOFF_TTL_SEC = 86_400; // = M-4 session TTL 上限 — 覆蓋所有可能存在嘅 session

/** reset password 時叫 — 該 staff 所有舊 session 即刻失效（本地 + Redis 持久化）。 */
export async function invalidateStaffSessions(staffId: string): Promise<void> {
  const now = Date.now();
  sessionCutoffs.set(staffId, now);
  // 順手清舊 entry（cutoff 只係短暫安全網：staff 重新 login 後新 session loginAt > cutoff 就冇用，24h 後清）
  if (sessionCutoffs.size > 1000) {
    for (const [k, v] of sessionCutoffs) if (now - v >= 86_400_000) sessionCutoffs.delete(k);
  }
  // Redis 持久化 — 寫失敗降級 local-only + warn（Redis 落咗個 app 都已經降级，queue 要佢）
  try {
    await getRedis().set(`${SESS_CUTOFF_PREFIX}${staffId}`, String(now), "EX", SESS_CUTOFF_TTL_SEC);
  } catch (err) {
    log.warn({ staffId, err: err instanceof Error ? err.message : String(err) }, "rbac: cutoff Redis 寫入失敗（降級 local-only）");
  }
}

/**
 * session 有冇被 cutoff 咗（requireAuth + hub connect 共用）。
 * fail-closed：session 冇 loginAt（舊格式 / 偽造）→ 當失效。
 * Redis 讀取失敗 → 降級 local Map（log warn；Redis 落咗個 app 已經降级）。
 */
export async function isStaffSessionCurrent(data: Pick<SessionData, "staffId" | "loginAt">): Promise<boolean> {
  if (typeof data.loginAt !== "number") return false;
  const local = sessionCutoffs.get(data.staffId);
  if (local !== undefined && data.loginAt < local) return false;
  try {
    const raw = await getRedis().get(`${SESS_CUTOFF_PREFIX}${data.staffId}`);
    if (raw) {
      const cutoff = Number(raw);
      if (Number.isFinite(cutoff) && data.loginAt < cutoff) return false;
    }
  } catch (err) {
    log.warn({ staffId: data.staffId, err: err instanceof Error ? err.message : String(err) }, "rbac: cutoff Redis 讀取失敗（local-only）");
  }
  return true;
}

/**
 * 要求已登入（ADMIN 或 STAFF 都過）。
 * 未登入 / session 无效 → 401；帳號停用 → 401 "account disabled"（P0-3 即時生效）。
 */
export async function requireAuth(req: NextRequest): Promise<AuthContext> {
  const { data, res } = await getSession(req);
  if (!data) {
    throw new RbacError(401, "unauthorized");
  }
  if (!(await isStaffActive(data.staffId))) {
    throw new RbacError(401, "account disabled");
  }
  // ★ C-3 尾批：password reset 後嘅舊 session → 401（同停用同水位）
  if (!(await isStaffSessionCurrent(data))) {
    throw new RbacError(401, "session invalidated");
  }
  return toContext(data, res);
}

/**
 * 要求 ADMIN。未登入 → 401；STAFF → 403。
 */
export async function requireAdmin(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  if (ctx.staff.role !== "ADMIN") {
    throw new RbacError(403, "admin required");
  }
  return ctx;
}

/**
 * STAFF 硬性綁定 clinicId 嘅 query scope helper：
 *   where: { ...clinicScope(ctx) }
 * ADMIN → {}（跨店）；STAFF → { clinicId }（只自己店）。
 * 所有按店過濾嘅 Prisma query 都必過呢個，唔好手寫 clinicId 條件。
 */
export function clinicScope(ctx: {
  staff: { role: "ADMIN" | "STAFF" };
  clinicId: string | null;
}): { clinicId?: string } {
  if (ctx.staff.role === "STAFF") {
    if (!ctx.clinicId) {
      // STAFF 冇 clinicId = 壞 session，直接擋
      throw new RbacError(401, "staff session missing clinicId");
    }
    return { clinicId: ctx.clinicId };
  }
  return {};
}

/** 單店訪問檢查（e.g. GET /api/conversations/[id]）：STAFF 只准入自己店嘅 entity。 */
export function assertClinicAccess(
  ctx: Pick<AuthContext, "staff" | "clinicId">,
  targetClinicId: string
): void {
  if (ctx.staff.role === "STAFF" && ctx.clinicId !== targetClinicId) {
    throw new RbacError(403, "cross-clinic access denied");
  }
}

function toContext(data: SessionData, res: AuthContext["res"]): AuthContext {
  // Fail-closed：role 必須係已知值（防壞 session / role 字串注入）
  if (data.role !== "ADMIN" && data.role !== "STAFF") {
    throw new RbacError(401, "invalid session role");
  }
  // Fail-closed：STAFF 必須有 clinicId — 冇 clinicId 嘅 STAFF context 會令 query 變成無 scope（跨店讀），
  // 所以喺最底層呢度就擋死，唔靠每個 route 記得調 clinicScope。
  if (data.role === "STAFF" && !data.clinicId) {
    throw new RbacError(401, "staff session missing clinicId");
  }
  return {
    staff: {
      id: data.staffId,
      email: data.email,
      name: data.name,
      role: data.role,
    },
    clinicId: data.clinicId,
    res,
  };
}
