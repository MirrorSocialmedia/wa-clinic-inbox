import { randomUUID } from "node:crypto";
import { getRedis } from "@/lib/queue";
import log from "@/lib/log";
import prisma from "@/lib/prisma";
import { resolveClinicIds, type ScopeType } from "@/lib/rbac";
import { EVENT_SCHEMAS } from "@/lib/realtime-events";

/**
 * ★ Realtime P0 (R2, cwi-rt-20260823-a1) — commit-then-emit 鐵律（MD §2 R2）：
 *
 *   任何 socket publish（publishNotify / publishStaffNotify / publishControl）
 *   必須喺 DB transaction 成功 commit 之後先調用。
 *   publish 調用永遠唔准出現喺 `$transaction(async (tx) => { ... })` callback 入面。
 *
 *   點解：tx 回滾時若已經 emit → UI 收到「訊息到了」但 DB 冇 row → 幻影訊息，
 *   staff 見到嘅同 DB 唔一致（最嚴重嘅 realtime bug 類別）。
 *   正確 pattern：
 *     const result = await prisma.$transaction(async (tx) => { ...; return {...}; });
 *     // ← tx 成功 return = 已 commit
 *     publishNotify(clinicId, event, payload);   // ← 先 emit
 *
 *   防護：(1) eslint local rule `no-publish-in-transaction`（CI 攔截）
 *        (2) chaos e2e Test I：PG trigger 強迫 rollback → 斷言零 socket event。
 *   audit（2026-08-23）：全 repo 6 個 $transaction 點（assign.ts / availability.ts /
 *   flow-reply.ts / inbound.worker.ts ×3）全部符合 — 0 違規。
 */

/**
 * 跨 process 實時通知橋（Redis pub/sub）。
 *
 * 架構：web server（Socket.IO）同 BullMQ workers 係兩個 PM2 process。
 * Worker 處理完 webhook event 後，冇辦法直接 emit 去 web process 嘅 io —
 * 所以經 Redis publish：
 *
 *   worker → publishNotify(clinicId, event, payload)
 *            → Redis channel "wa-inbox:notify"
 *   web    → subscriber 收到 → io.to(`clinic:${clinicId}`).emit(event, payload)
 *
 * ★ PII 邊界：payload 含訊息內容（病人/店員都要見到嘅 chat 內容）—
 * 只喺自己 VPS 嘅 Redis 內傳，唔出公網。log 只帶 event/clinicId metadata。
 */

export const NOTIFY_CHANNEL = "wa-inbox:notify";

export interface NotifyMessage {
  clinicId: string;
  event: string;
  payload: unknown;
  /** ★ H2：設咗 staffId → 只 emit 去 `staff:{staffId}` room（per-staff 定向，e.g. notify:mention） */
  staffId?: string;
}

// ── Control channel（P0-3 停用即時斷線） ──────────────────────────────────
//
// ★ 點解要經 Redis 而唔係直接調 disconnectStaff()：
//   custom server 架構下，server.ts（持 io + staffSockets map）同 Next 編譯咗嘅
//   API route handler 各持一份 hub.ts module instance（dev 下两套 module graph；
//   prod standalone 亦會係唔同 require cache key）— route 直接調 disconnectStaff()
//   會落到 state.io === null 嗰份 instance → 靜默 return 0（E2E T42 捉住）。
//   經 Redis publish 過一次，就由「真正持 io 嗰份 instance」去斷線 — 同一個
//   process（dev）或者另一個 PM2 cluster node（socket 喺邊個 node 就由邊個斷）都 work。
export const CONTROL_CHANNEL = "wa-inbox:control";

export type ControlMessage =
  | { cmd: "staff:changed"; staffId: string; active: boolean }
  // C-3 尾批：password reset → 踢晒該 staff 所有 session（hub 側設 cutoff + 斷已連 socket）
  | { cmd: "staff:sessions-invalidated"; staffId: string }
  // ★ Fix B（cwi-fix-20260825-f1）：跨 process cache 失效（web ⇄ worker 各自持 in-memory TTL cache）
  // ★ Part F（cwi-raggolden-20260904）：+ knowledge（知識庫目錄字串 cache 5 分鐘 — 更新即刻生效）
  | { cmd: "cache:bust"; scope: "automation" | "workflow" | "knowledge" }
  // ★ cwi-refresh-20260831 §3：availability L2 該日已 bust + 重填 → web 側 socket emit 俾 UI 即時重繪
  //   （payload 零 PII：clinicCode/clinicId/date 都係營運元數據）
  | { cmd: "availability:busted"; clinicCode: string; clinicId: string; date: string }
  // ★ cwi-final S1-4：staff 範圍/技能組改動 → 清各 process 嘅 publishConvEvent scope cache（60s → 即刻）
  | { cmd: "scope:changed" };

/**
 * 發控制指令（fire-and-forget）：Redis 故障時 log — API 側嘅 cache 失效已經做咗，
 * socket 斷線會延後到 active cache 60s 到期（fail-closed 兜底）。
 */
export function publishControl(msg: ControlMessage): void {
  getRedis()
    .publish(CONTROL_CHANNEL, JSON.stringify(msg))
    .catch((err) => {
      log.warn(
        // ★ Fix B：cache:bust 冇 staffId 欄 — 安全取值避免 undefined key 混入 log
        { cmd: msg.cmd, staffId: "staffId" in msg ? msg.staffId : undefined, err: err instanceof Error ? err.message : String(err) },
        "control: publish failed（socket 斷線會延後到 active cache 到期）"
      );
    });
}

/**
 * 發通知（fire-and-forget）：Redis 故障唔應該阻塞 inbound pipeline
 * （UI 會經 reconnect backlog 補齊）。
 */
export function publishNotify(clinicId: string, event: string, payload: unknown): void {
  const data = JSON.stringify({ clinicId, event, payload } satisfies NotifyMessage);
  getRedis()
    .publish(NOTIFY_CHANNEL, data)
    .catch((err) => {
      log.warn(
        { clinicId, event, err: err instanceof Error ? err.message : String(err) },
        "notify: publish failed (UI 會經 reconnect 補漏)"
      );
    });
}

/**
 * ★ H2：定向發畀指定 staff 嘅 socket（`staff:{staffId}` room）。
 * 用法：notify:mention（只 @ 中嗰個人收，唔廣播全店）。
 * clinicId 只係 log metadata（staff 本身綁店）。
 */
export function publishStaffNotify(staffId: string, clinicId: string, event: string, payload: unknown): void {
  const data = JSON.stringify({ clinicId, staffId, event, payload } satisfies NotifyMessage);
  getRedis()
    .publish(NOTIFY_CHANNEL, data)
    .catch((err) => {
      log.warn(
        { staffId: staffId.slice(-6), clinicId, event, err: err instanceof Error ? err.message : String(err) },
        "notify: staff publish failed (UI 會經 reconnect 補漏)"
      );
    });
}

// ── ★ cwi-final S1-4：對話級事件統一出口（跨店 realtime）────────────────────
//
// 現況：clinic room 只覆蓋「綁咗呢間店」嘅人 — 跨店 assignee 同跨店路由組員收唔到
// 對話級事件（message:new 只補推 assignee，其他事件完全冇補）。
//
// 設計（spec S1-4）：
// - clinic room（店內所有人）＋「覆蓋唔到呢間店」嘅相關員工 staff room：
//   assignee 有 → 只 assignee；assignee null → routedStaffId + routedGroupId active 組員
//   （兩個 if — routedStaffId 同 routedGroupId 可以同時有值：組得一個當值人）
// - 已經喺 clinic room 嘅人唔再推 staff room；payload 帶 eventId 俾 client 去重（雙保險）
// - 60s in-memory cache（worker / web 兩 process 各一份）；`admin/staff/[id]` PUT 成功 →
//   control 橋 `scope:changed` 即刻清（bustScopeCache）

export interface ConvRef {
  id: string;
  clinicId: string;
  assigneeId: string | null;
  routedStaffId: string | null;
  routedGroupId: string | null;
}

/** Prisma Conversation（或任何帶齊五欄嘅 row）→ ConvRef（structural typing）。 */
export function convRef(c: Pick<ConvRef, "id" | "clinicId" | "assigneeId" | "routedStaffId" | "routedGroupId">): ConvRef {
  return {
    id: c.id,
    clinicId: c.clinicId,
    assigneeId: c.assigneeId,
    routedStaffId: c.routedStaffId,
    routedGroupId: c.routedGroupId,
  };
}

const SCOPE_CACHE_TTL_MS = 60_000;

interface ScopeCacheEntry<T> {
  value: T;
  expiresAt: number;
}

const groupMembersCache = new Map<string, ScopeCacheEntry<string[]>>();
const staffCoversClinicCache = new Map<string, ScopeCacheEntry<boolean>>();

/** `scope:changed` control cmd → 清本 process 嘅 scope cache（staff 範圍/組改動即刻生效）。 */
export function bustScopeCache(): void {
  groupMembersCache.clear();
  staffCoversClinicCache.clear();
}

/** 技能組 active 成員（60s cache）。
 * ★ cwi-final S1-5：export 畀 push.ts（L-2 路由目標收件人 — 同一份 cache，唔開第二套）。 */
export async function groupMembersCached(groupId: string): Promise<string[]> {
  const now = Date.now();
  const hit = groupMembersCache.get(groupId);
  if (hit && hit.expiresAt > now) return hit.value;
  const rows = await prisma.skillGroupMember.findMany({ where: { groupId }, select: { staffId: true } });
  const staffIds = [...new Set(rows.map((r) => r.staffId))];
  let value: string[] = [];
  if (staffIds.length > 0) {
    const active = await prisma.staffUser.findMany({
      where: { id: { in: staffIds }, active: true },
      select: { id: true },
    });
    const activeSet = new Set(active.map((s) => s.id));
    value = staffIds.filter((sid) => activeSet.has(sid));
  }
  groupMembersCache.set(groupId, { value, expiresAt: now + SCOPE_CACHE_TTL_MS });
  return value;
}

/**
 * 該 staff 有冇覆蓋（能見到）呢間店？true = 已經喺 clinic room（唔使再推 staff room）。
 * SUPERVISOR / scopeType ALL = true；inactive = true（當已覆蓋 = 唔推 — 避免推畀登入唔到嘅帳號）；
 * staff 行唔存在（已刪）= true（冇接收對象）；60s cache。
 */
async function staffCoversClinicCached(staffId: string, clinicId: string): Promise<boolean> {
  const key = `${staffId}|${clinicId}`;
  const now = Date.now();
  const hit = staffCoversClinicCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  let value = true;
  const staff = await prisma.staffUser.findUnique({
    where: { id: staffId },
    select: {
      role: true,
      scopeType: true,
      scopeCompanyId: true,
      active: true,
      clinics: { select: { clinicId: true } },
    },
  });
  if (staff && staff.active && staff.role !== "SUPERVISOR" && staff.scopeType !== "ALL") {
    // fail-safe：scopeType 意外值 → 當 CLINICS（最窄範圍）— 錯推多過錯漏（client eventId 去重兜底）
    const scopeType: ScopeType = staff.scopeType === "COMPANY" ? "COMPANY" : "CLINICS";
    const ids = await resolveClinicIds({
      scopeType,
      scopeCompanyId: staff.scopeCompanyId,
      staffClinicIds: staff.clinics.map((c) => c.clinicId),
    });
    value = ids.includes(clinicId);
  }
  staffCoversClinicCache.set(key, { value, expiresAt: now + SCOPE_CACHE_TTL_MS });
  return value;
}

/**
 * ★ S1-4 對話級事件唯一出口：clinic room（店內所有人）+ 跨店相關員工 staff room。
 * payload 注入 eventId（client 去重）；S1-7 契約驗證（dev/test parse throw；prod safeParse log 唔 throw）。
 */
export async function publishConvEvent(conv: ConvRef, event: string, payload: Record<string, unknown>): Promise<void> {
  const p: Record<string, unknown> = {
    ...payload,
    eventId: (payload.eventId as string | undefined) ?? randomUUID(),
  };

  // ★ S1-7 事件契約：dev/test fail-fast；prod log-only（realtime 通知唔准拖累主業務）
  const schema = EVENT_SCHEMAS[event];
  if (schema) {
    if (process.env.NODE_ENV === "production") {
      const r = schema.safeParse(p);
      if (!r.success) {
        log.error(
          { event, clinicId: conv.clinicId, issues: r.error.issues },
          "publishConvEvent: payload 唔過 schema（prod — log only，唔 throw）"
        );
      }
    } else {
      schema.parse(p);
    }
  } else {
    log.warn({ event, clinicId: conv.clinicId }, "publishConvEvent: 事件無註冊 schema（契約缺口 — 補 realtime-events.ts）");
  }

  publishNotify(conv.clinicId, event, p);
  for (const staffId of await crossClinicTargets(conv)) {
    publishStaffNotify(staffId, conv.clinicId, event, p);
  }
}

/** 跨店補推目標：assignee 有 → 只 assignee；assignee null → routedStaffId + 組員；再過濾「已覆蓋呢間店」嘅人。 */
async function crossClinicTargets(conv: ConvRef): Promise<string[]> {
  const ids = new Set<string>();
  if (conv.assigneeId) {
    ids.add(conv.assigneeId);
  } else {
    // ★ 兩個 if（唔好 else if 掉 group）：routedStaffId 同 routedGroupId 可以同時有值
    if (conv.routedStaffId) ids.add(conv.routedStaffId);
    if (conv.routedGroupId) {
      for (const m of await groupMembersCached(conv.routedGroupId)) ids.add(m);
    }
  }
  const out: string[] = [];
  for (const id of ids) {
    if (!(await staffCoversClinicCached(id, conv.clinicId))) out.push(id);
  }
  return out;
}
