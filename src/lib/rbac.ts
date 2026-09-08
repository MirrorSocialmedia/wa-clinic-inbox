import { type NextRequest } from "next/server";
import { getSession, type SessionData } from "@/lib/session";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getRedis } from "@/lib/queue";

/**
 * WA Clinic Inbox — RBAC 基礎（框架 MD D10 / §6.4）
 *
 * 權限模型（cwi-h6-20260830 多店化）：
 * - ADMIN  → 跨店（clinicId = null，可睇全部店）
 * - STAFF  → 綁定店集合 StaffClinic（clinicIds 硬性綁定；每條 query 都必過 clinicScope，
 *            唔靠前端收埋）。conversation 級另有單線授權：assigneeId == 自己
 *            （派俾完全外店嘅人嗰條線，見 assertConversationAccess）
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
  /** ★ cwi-routing-20260906（§8）：SUPERVISOR = 全店唯讀 + AI 級別讀寫；覆客/指派/設定一律 403。 */
  role: "ADMIN" | "STAFF" | "SUPERVISOR";
}

export interface AuthContext {
  staff: StaffInfo;
  /** STAFF = 主店（StaffClinic isPrimary；舊 session = 唯一店）；ADMIN = null（跨店） */
  clinicId: string | null;
  /** ★ cwi-h6-20260830：綁定店集合。ADMIN = []（全店，scope 不限）；STAFF = StaffClinic 全部 clinicId（≥1，fail-closed）。舊 session 冇呢個欄 → fallback [clinicId]。 */
  clinicIds: string[];
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
 * ★ cwi-routing-20260906（§8）：要求 ADMIN 或 SUPERVISOR（STAFF → 403）。
 * 用途：AI 自動化級別（含 panic 降 L1）+ AI 建議頁 — 主管讀寫，其餘設定類仍然 admin-only。
 */
export async function requireAdminOrSupervisor(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  if (ctx.staff.role !== "ADMIN" && ctx.staff.role !== "SUPERVISOR") {
    throw new RbacError(403, "admin or supervisor required");
  }
  return ctx;
}

/**
 * STAFF 硬性綁定 clinicIds 嘅 query scope helper（cwi-h6-20260830 多店化）：
 *   where: { ...clinicScope(ctx) }
 * ADMIN → {}（跨店）；STAFF → { clinicId: { in: [店1, 店2, ...] } }（只綁定店）。
 * 所有按店過濾嘅 Prisma query 都必過呢個，唔好手寫 clinicId 條件。
 */
export function clinicScope(ctx: {
  staff: { role: "ADMIN" | "STAFF" | "SUPERVISOR" };
  clinicIds: string[];
}): { clinicId?: { in: string[] } } {
  if (ctx.staff.role === "STAFF") {
    if (!ctx.clinicIds.length) {
      // STAFF 冇店集合 = 壞 session，直接擋
      throw new RbacError(401, "staff session missing clinics");
    }
    return { clinicId: { in: ctx.clinicIds } };
  }
  return {};
}

// ── ★ cwi-auditfix-20260908（B-1 兜底）：我嘅技能組集合（in-process 60s cache）─────────
// 路由 = 單線授權：對話 routedGroupId ∈ 我組（或 routedStaffId == 我）→ 放行，
// 唔受 StaffClinic 綁定限制（組成員唔綁該店都必須開得到 — 否則 route 通知 = 鎖死）。
const groupCache = new Map<string, { at: number; groupIds: Set<string> }>();
const GROUP_TTL_MS = 60_000;

export async function myGroupIds(staffId: string): Promise<Set<string>> {
  const now = Date.now();
  const hit = groupCache.get(staffId);
  if (hit && now - hit.at < GROUP_TTL_MS) return hit.groupIds;
  let groupIds = new Set<string>();
  try {
    const rows = await prisma.skillGroupMember.findMany({ where: { staffId }, select: { groupId: true } });
    groupIds = new Set(rows.map((r) => r.groupId));
  } catch (err) {
    // fail-closed：DB 故障 → 空集合（唔放寬路由支路；clinic/assignee 支路照舊）
    log.warn({ staffId, err: err instanceof Error ? err.message : String(err) }, "rbac: myGroupIds DB error — fail-closed（空集合）");
  }
  groupCache.set(staffId, { at: now, groupIds });
  if (groupCache.size > 1000) {
    for (const [k, v] of groupCache) if (now - v.at >= GROUP_TTL_MS * 2) groupCache.delete(k);
  }
  return groupIds;
}

/** admin 改咗組成員時叫 — 放行語義即時生效（唔使等 60s cache）。 */
export function invalidateGroupCache(staffId?: string): void {
  if (staffId) groupCache.delete(staffId);
  else groupCache.clear();
}

/**
 * ★ cwi-h6-20260830：conversation 級 access（取代大部分 assertClinicAccess call site）。
 * 模型（MD §0）：可以睇/覆一個 conversation =
 *   ADMIN ∨ conv.clinicId ∈ 我嘅店集合 ∨ conv.assigneeId == 我（單線授權 — 派俾完全外店嘅人嗰條線）
 *   ★ cwi-routing-20260906（§8）：SUPERVISOR = 全店放行（唯讀語義 — 寫嘅鐵律喺 assertCanWriteConversation）
 *   ★ cwi-auditfix-20260908（B-1 兜底）：∨ conv.routedStaffId == 我 ∨ conv.routedGroupId ∈ 我組
 *   （路由 = 單線授權，同 assignee 語義一致 — 組成員唔綁該店都開得到被 route 嘅對話）。
 *
 * ★ async（B-1）：routedGroupId 支路要打 DB 查我組（60s cache）→ 所有 call site 要 await。
 * conv 參數嘅 routed* 欄係 optional — 冇帶 = 嗰兩條支路自然唔成立（唔改 call site select 都唔會假放行）。
 */
export async function assertConversationAccess(
  ctx: Pick<AuthContext, "staff" | "clinicIds">,
  conv: { clinicId: string; assigneeId: string | null; routedStaffId?: string | null; routedGroupId?: string | null }
): Promise<void> {
  if (ctx.staff.role === "ADMIN" || ctx.staff.role === "SUPERVISOR") return;
  if (ctx.clinicIds.includes(conv.clinicId)) return;
  if (conv.assigneeId === ctx.staff.id) return; // 單線授權（指派）
  // ★ cwi-auditfix-20260908（B-1）：路由單線授權
  if (conv.routedStaffId && conv.routedStaffId === ctx.staff.id) return;
  if (conv.routedGroupId && (await myGroupIds(ctx.staff.id)).has(conv.routedGroupId)) return;
  throw new RbacError(403, "no access to this conversation");
}

/**
 * ★ cwi-h6-20260830：conversation 列表 scope（queue 欄 / 搜尋）：
 * ADMIN → {}；STAFF → 自己所有店 ∪ 我係負責人嘅對話（單線授權 — 外店派咗落嚟嗰條線）。
 * 注意：呢個係列表層級；單對話 access 仍以 assertConversationAccess 為準。
 */
export function conversationScope(ctx: {
  staff: { role: "ADMIN" | "STAFF" | "SUPERVISOR"; id: string };
  clinicIds: string[];
}): Record<string, unknown> {
  if (ctx.staff.role === "STAFF") {
    if (!ctx.clinicIds.length) throw new RbacError(401, "staff session missing clinics");
    return { OR: [{ clinicId: { in: ctx.clinicIds } }, { assigneeId: ctx.staff.id }] };
  }
  return {};
}

/** 單店訪問檢查（clinic 級 entity：booking / contact / flow hold 等 — cwi-h6-20260830 多店化：目標店 ∈ 我嘅店集合）。 */
export function assertClinicAccess(
  ctx: Pick<AuthContext, "staff" | "clinicIds">,
  targetClinicId: string
): void {
  if (ctx.staff.role === "STAFF" && !ctx.clinicIds.includes(targetClinicId)) {
    throw new RbacError(403, "cross-clinic access denied");
  }
}

/**
 * cwi-sched-20260901 §4：時間表全店唯讀檢查。
 *
 * 時間表係非敏感資料（只有醫生名 + 席數，零病人資料）→ 所有 active staff 可讀任何店。
 *
 * ⚠️ 只准用喺 /schedule 同 /api/flows/slots?granularity=* 嘅讀路徑。
 * 落單 / claim / commit 一律唔准用呢個 — 嗰啲繼續用 assertConversationAccess / clinicIds。
 *
 * 實作：active 已經由 requireAuth 驗咗（P0-3 isStaffActive fail-closed + 60s cache），
 * 所以呢度唔重查 DB；職責 = 明確標記讀路徑邊界（全店唯讀、唔查 clinic）+ 未來加緊位。
 */
export function assertScheduleReadAccess(_ctx: Pick<AuthContext, "staff">): void {
  void _ctx; // active 已驗（requireAuth）；呢度刻意唔查 clinic — 全店唯讀
}

/**
 * ★ cwi-routing-20260906（§8）：覆客寫入鐵律 — 發訊息 / 採用 AI 草稿 / 接手（assign）/ 落單 /
 * 發 Flow 嘅 route 一律先調呢個：SUPERVISOR → 403（主管覆唔到客）；ADMIN/STAFF 放行。
 * （讀路徑繼續用 assertConversationAccess — 唯讀唔受影響。）
 */
export function assertCanWriteConversation(ctx: Pick<AuthContext, "staff">): void {
  if (ctx.staff.role === "SUPERVISOR") {
    throw new RbacError(403, "supervisor is read-only — 覆客操作唔准");
  }
}

function toContext(data: SessionData, res: AuthContext["res"]): AuthContext {
  // Fail-closed：role 必須係已知值（防壞 session / role 字串注入）
  if (data.role !== "ADMIN" && data.role !== "STAFF" && data.role !== "SUPERVISOR") {
    throw new RbacError(401, "invalid session role");
  }
  // ★ cwi-h6-20260830：clinicIds — 新 session 由 login 寫入（StaffClinic 查詢）；
  // 舊 session（冇 clinicIds 欄）fallback [clinicId]（行為同舊版完全一致 — T98 驗收）。
  const clinicIds =
    data.role === "ADMIN" || data.role === "SUPERVISOR"
      ? [] // ★ §8：SUPERVISOR 全店（同 ADMIN 一樣 scope 不限）
      : data.clinicIds?.length
        ? data.clinicIds
        : data.clinicId
          ? [data.clinicId]
          : null;
  // Fail-closed：STAFF 必須有店集合 — 冇店嘅 STAFF context 會令 query 變無 scope（跨店讀），
  // 所以喺最底層呢度就擋死，唔靠每個 route 記得調 clinicScope。
  if (data.role === "STAFF" && !clinicIds) {
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
    clinicIds: clinicIds ?? [],
    res,
  };
}
