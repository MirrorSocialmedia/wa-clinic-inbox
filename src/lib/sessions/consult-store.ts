/**
 * ★ cwi-hubaudit-20260915（S2 / H-2 修復）— ConsultStore：consult engine / LLM turn 嘅
 * 持久化 + 發送唯一分岔點（鐵律 2：mode 分支只准喺持久化同發送層）。
 *
 * - `prismaConsultStore` — worker 真路徑（ConsultSession 表 + auditLog + staffNotice/publishNotify）。
 *   代碼由 consult-runner.ts 逐字搬遷（worker 行為零改動 — 鐵律 1）；
 *   `persistConsultExtraction` 亦經呢度（接口保留）。
 * - `redisConsultStore` — 沙盤 display-only（Redis sandbox state slot）：
 *   零 DB 寫、零 staffNotice、零 publish（T363 沙盤零副作用斷言維持綠）。
 *
 * row = 唯讀投影（ConsultSessionRow）— `toSessionState` 消費；store 內部處理真 row 型別。
 * sandbox 唔再平行實作 consult 迴圈（H-2）— `runConsultEngineTurn` / `runConsultLlmTurn`
 * 係 worker 同沙盤唯一入口。
 */
import type { Prisma, PrismaClient, ConsultSession } from "@prisma/client";
import log from "@/lib/log";
import { publishConvEvent, convRef } from "@/lib/notify";
import type { ConsultSessionState } from "./consult-engine";

// ── 接口 ───────────────────────────────────────────────────────────────

/** ConsultSession row 唯讀投影（toSessionState 所需 12 欄 + id / lastOutboundText）。 */
export interface ConsultSessionRow {
  id: string;
  workflow: string;
  stage: string;
  terminal: string | null;
  turnCount: number;
  purchaseIntent: number;
  slots: Prisma.JsonValue | null;
  candidateCategory: string | null;
  comparedProducts: string[];
  askedSlots: string[];
  objections: Prisma.JsonValue | null;
  ctaGiven: boolean;
  humanTookOver: boolean;
  lastAction: string | null;
  /** Conversation 過渡欄（prisma store = 真 row 欄；redis store = 恆 null）。 */
  lastOutboundText: string | null;
}

/** conversation 最小引用（真 Conversation 結構性滿足；沙盤傳合成 ref）。 */
export interface ConsultConvRef {
  id: string;
  clinicId: string;
  humanTookOver?: boolean;
  lastOutboundText?: string | null;
}

export interface ConsultSync {
  humanTookOver?: boolean;
  lastOutboundText?: string | null;
}

/** processed turn 嘅寫入資料（optional 欄 = 只喺非 null 時寫 — 同原 runner 語義）。 */
export interface ConsultTurnData {
  stage: string;
  turnCount: number;
  purchaseIntent: number;
  lastAction: string | null;
  nextAction: string | null;
  objections: Prisma.JsonValue;
  askedSlots: string[];
  ctaGiven: boolean;
  terminal?: string | null;
  candidateCategory?: string | null;
  slots?: Prisma.JsonValue;
}

export interface PersistTurnInput {
  sessionId: string;
  /** null = processed:false — 只 sync 欄（或 no-op）。 */
  data: ConsultTurnData | null;
  sync?: ConsultSync;
}

export interface ConsultAuditInput {
  action: string;
  entityId: string;
  meta: object;
}

export type TerminalEffectKind = "HANDOFF_HUMAN" | "PAIN_TRIAGE" | "END_SESSION";

export interface TerminalEffectInput {
  kind: TerminalEffectKind;
  meta: {
    sessionId: string;
    row: number;
    reason?: string;
    msgId?: string;
  };
}

export interface ConsultExtractionInput {
  sessionId: string;
  slotUpdates: Record<string, string | number>;
  objection: string | null;
  askedFlags: Record<string, boolean>;
  msgId: string;
  mock: boolean;
}

export interface ConsultStore {
  /** get/create active session（prisma: tx FOR UPDATE + C1 橋接；redis: state slot）。 */
  getOrCreateActive(opts: {
    workflow: string;
    bridge: { humanTookOver: boolean; lastOutboundText: string | null };
  }): Promise<{ session: ConsultSessionRow; created: boolean }>;
  persistTurn(input: PersistTurnInput): Promise<void>;
  audit(input: ConsultAuditInput): Promise<void>;
  /** terminal action 對話層（staffNotice/publish/follow-up audit）— 沙盤 no-op。 */
  terminalEffect(input: TerminalEffectInput): Promise<void>;
  persistExtraction(input: ConsultExtractionInput): Promise<string[]>;
}

/** Conversation → ref（worker 舊 interface 兼容：真 Conversation 直接可當 ref 用）。 */
export function convRefOf(
  conv: Pick<import("@prisma/client").Conversation, "id" | "clinicId" | "humanTookOver" | "lastOutboundText">
): ConsultConvRef {
  return { id: conv.id, clinicId: conv.clinicId, humanTookOver: conv.humanTookOver, lastOutboundText: conv.lastOutboundText };
}

// ── prisma store（worker — 原 consult-runner.ts 代碼逐字搬遷） ─────────

function rowOf(s: ConsultSession): ConsultSessionRow {
  return {
    id: s.id,
    workflow: s.workflow,
    stage: s.stage,
    terminal: s.terminal,
    turnCount: s.turnCount,
    purchaseIntent: s.purchaseIntent,
    slots: s.slots,
    candidateCategory: s.candidateCategory,
    comparedProducts: s.comparedProducts,
    askedSlots: s.askedSlots,
    objections: s.objections,
    ctaGiven: s.ctaGiven,
    humanTookOver: s.humanTookOver,
    lastAction: s.lastAction,
    lastOutboundText: s.lastOutboundText,
  };
}

/** 既有 handoff 模式（同 COMPLAINT 路徑同一份 staffNotice + publishNotify pattern — 唔發明）。 */
async function handoffNotice(
  prisma: PrismaClient,
  ref: ConsultConvRef,
  title: string,
  meta: object
): Promise<void> {
  try {
    await prisma.staffNotice.create({
      data: {
        clinicId: ref.clinicId,
        conversationId: ref.id,
        kind: "HANDOFF_REQUEST",
        title,
        meta,
      },
    });
    // ★ cwi-final S1-4：ref 只有 id+clinicId → 補五欄
    const convRow = await prisma.conversation.findUnique({
      where: { id: ref.id },
      select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
    });
    if (convRow) await publishConvEvent(convRef(convRow), "notice:new", { conversationId: ref.id, kind: "HANDOFF_REQUEST" });
  } catch (err) {
    log.warn({ err: String(err) }, "consult-engine: handoff notice failed（fail-soft）");
  }
}

export function prismaConsultStore(prisma: PrismaClient, conv: ConsultConvRef): ConsultStore {
  const ref: ConsultConvRef = { humanTookOver: false, lastOutboundText: null, ...conv };

  return {
    async getOrCreateActive({ workflow, bridge }) {
      // C2 守衛：tx 內 Conversation FOR UPDATE + 只准一個 active（terminal 後新 trigger 可開新）
      const result = await prisma.$transaction(async (tx) => {
        const _lock = await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${ref.id} FOR UPDATE`;
        const existing = await tx.consultSession.findFirst({ where: { conversationId: ref.id, terminal: null } });
        if (existing) return { row: existing, created: false };
        const created = await tx.consultSession.create({
          data: {
            conversationId: ref.id,
            clinicId: ref.clinicId,
            workflow,
            // ★ C1 橋接：session 級副本由 Conversation 過渡欄複製
            humanTookOver: bridge.humanTookOver,
            lastOutboundText: bridge.lastOutboundText,
          },
        });
        return { row: created, created: true };
      });
      if (result.created) {
        await prisma.auditLog
          .create({
            data: {
              staffId: null, // AI 自動（無 staff 參與）
              action: "CONSULT_SESSION_CREATE",
              entity: "ConsultSession",
              entityId: result.row.id,
              meta: {
                conversationId: ref.id,
                clinicId: ref.clinicId,
                workflow,
                stage: "DISCOVER",
                bridgedFromConversation: {
                  humanTookOver: ref.humanTookOver,
                  hasLastOutboundText: ref.lastOutboundText != null,
                },
              } as object,
            },
          })
          .catch((err) => log.warn({ err: String(err) }, "consult-engine: create audit failed（fail-soft）"));
      }
      return { session: rowOf(result.row), created: result.created };
    },

    async persistTurn({ sessionId, data, sync }) {
      if (data) {
        // 開頭 sync 只喺有寫入時順帶（零額外 query）；optional 欄照原語義（非 null 先寫）
        const d: Record<string, unknown> = { ...data };
        if (sync?.humanTookOver) d.humanTookOver = true;
        if (sync?.lastOutboundText != null) d.lastOutboundText = sync.lastOutboundText;
        await prisma.consultSession.update({ where: { id: sessionId }, data: d as Prisma.ConsultSessionUpdateInput });
      } else if (sync?.humanTookOver || sync?.lastOutboundText != null) {
        // processed:false — 只 sync 欄（session 零欄寫入語義維持）
        await prisma.consultSession
          .update({
            where: { id: sessionId },
            data: {
              ...(sync.humanTookOver ? { humanTookOver: true } : {}),
              ...(sync.lastOutboundText != null ? { lastOutboundText: sync.lastOutboundText } : {}),
            },
          })
          .catch((err) => log.warn({ err: String(err) }, "consult-engine: sync update failed（fail-soft）"));
      }
    },

    async audit({ action, entityId, meta }) {
      await prisma.auditLog
        .create({
          data: {
            staffId: null,
            action,
            entity: "ConsultSession",
            entityId,
            meta: meta as object,
          },
        })
        .catch((err) => log.warn({ err: String(err) }, `consult-engine: ${action} audit failed（fail-soft）`));
    },

    async terminalEffect({ kind, meta }) {
      if (kind === "HANDOFF_HUMAN") {
        await handoffNotice(prisma, ref, `CONSULT 轉人手（row ${meta.row}）`, {
          row: meta.row,
          sessionId: meta.sessionId,
          reason: meta.reason,
        });
      } else if (kind === "PAIN_TRIAGE") {
        await handoffNotice(prisma, ref, "CONSULT 痛症訊號 → PAIN_TRIAGE", { row: meta.row, sessionId: meta.sessionId });
      } else if (kind === "END_SESSION") {
        // 排 follow-up = audit placeholder（FollowupTask model 本 repo 未實施 — 只記錄）
        await prisma.auditLog
          .create({
            data: {
              staffId: null,
              action: "CONSULT_FOLLOWUP_SCHEDULED",
              entity: "ConsultSession",
              entityId: meta.sessionId,
              meta: { reason: meta.row === 5 ? "patient-stop" : "decline", row: meta.row, msgId: meta.msgId } as object,
            },
          })
          .catch((err) => log.warn({ err: String(err) }, "consult-engine: follow-up audit failed（fail-soft）"));
      }
    },

    async persistExtraction({ sessionId, slotUpdates, objection, askedFlags, msgId, mock }) {
      try {
        const s = await prisma.consultSession.findUnique({ where: { id: sessionId } });
        if (!s) return [];
        const cur: Record<string, unknown> =
          s.slots && typeof s.slots === "object" && !Array.isArray(s.slots)
            ? { ...(s.slots as Record<string, unknown>) }
            : {};
        const next = { ...cur };
        const applied: string[] = [];
        for (const [k, v] of Object.entries(slotUpdates ?? {})) {
          if (k === "clinicalSuitability" || k === "meta") continue; // 鐵律
          next[k] = v; // 病人最新表達覆蓋（latest wins）
          applied.push(k);
        }
        if (applied.length > 0) {
          await prisma.consultSession.update({ where: { id: sessionId }, data: { slots: next as Prisma.InputJsonValue } });
        }
        await prisma.auditLog.create({
          data: {
            staffId: null,
            action: "CONSULT_EXTRACT",
            entity: "ConsultSession",
            entityId: sessionId,
            meta: { applied, objection, flags: askedFlags, msgId, mock } as object,
          },
        });
        return applied;
      } catch (err) {
        log.warn({ sessionId, err: String(err) }, "consult: persistExtraction failed（fail-soft）");
        return [];
      }
    },
  };
}

// ── redis store（沙盤 display-only） ──────────────────────────────────

/** sandbox state slot（SandboxRedisState.state 嘅 get/set 閉包 + 穩定 session id）。 */
export interface RedisConsultSlot {
  getSession: () => ConsultSessionState | null;
  setSession: (s: ConsultSessionState | null) => void;
  /** session id（trace/audit 用 — 只存 Redis，唔入 DB）。 */
  sessionId: string;
}

/** 新 session state（C1 口徑：DISCOVER / intent 0 / clinicalSuitability=UNKNOWN）。 */
export function freshConsultState(workflow: string, bridge?: { humanTookOver?: boolean }): ConsultSessionState {
  return {
    workflow: workflow as ConsultSessionState["workflow"],
    stage: "DISCOVER",
    terminal: null,
    turnCount: 0,
    purchaseIntent: 0,
    slots: { clinicalSuitability: "UNKNOWN" },
    candidateCategory: null,
    comparedProducts: [],
    askedSlots: [],
    objections: [],
    ctaGiven: false,
    humanTookOver: bridge?.humanTookOver ?? false,
    lastAction: null,
  };
}

function rowOfState(slotId: string, s: ConsultSessionState): ConsultSessionRow {
  return {
    id: slotId,
    workflow: s.workflow,
    stage: s.stage,
    terminal: s.terminal,
    turnCount: s.turnCount,
    purchaseIntent: s.purchaseIntent,
    slots: s.slots,
    candidateCategory: s.candidateCategory,
    comparedProducts: s.comparedProducts,
    askedSlots: s.askedSlots,
    objections: s.objections as unknown as Prisma.JsonValue,
    ctaGiven: s.ctaGiven,
    humanTookOver: s.humanTookOver,
    lastAction: s.lastAction,
    lastOutboundText: null,
  };
}

/**
 * 沙盤 store：全部 state 寫入只觸及 Redis slot（零 DB / 零 staffNotice / 零 publish）。
 * audit 只 log metadata（零 PII）— 沙盤無 audit 表可寫。
 */
export function redisConsultStore(slot: RedisConsultSlot): ConsultStore {
  return {
    async getOrCreateActive({ workflow, bridge }) {
      const cur = slot.getSession();
      // terminal / 無 state → 開新 session（同 prisma store：terminal 後新 trigger 開新）
      if (cur === null || cur.terminal !== null) {
        const fresh = freshConsultState(workflow, bridge);
        slot.setSession(fresh);
        return { session: rowOfState(slot.sessionId, fresh), created: true };
      }
      return { session: rowOfState(slot.sessionId, cur), created: false };
    },

    async persistTurn({ sessionId, data, sync }) {
      const cur = slot.getSession();
      if (!cur) return;
      let base = cur;
      if (sync?.humanTookOver && !base.humanTookOver) base = { ...base, humanTookOver: true };
      if (!data) return;
      const next: ConsultSessionState = {
        ...base,
        stage: data.stage,
        turnCount: data.turnCount,
        purchaseIntent: data.purchaseIntent,
        lastAction: data.lastAction,
        objections: data.objections as unknown as ConsultSessionState["objections"],
        askedSlots: data.askedSlots,
        ctaGiven: data.ctaGiven,
      };
      if (data.terminal !== undefined) next.terminal = data.terminal;
      if (data.candidateCategory !== undefined) next.candidateCategory = data.candidateCategory;
      if (data.slots !== undefined) next.slots = data.slots as ConsultSessionState["slots"];
      slot.setSession(next);
      void sessionId;
    },

    async audit({ action, entityId, meta }) {
      // 沙盤：metadata-only log（零 PII；零 DB 寫 — 鐵律 3）
      log.debug({ scope: "sandbox-consult", action, entityId, ...meta }, "sandbox consult audit（metadata only）");
    },

    async terminalEffect() {
      // 鐵律 3：display-only — 零 staffNotice / 零 publish / 零 DB
    },

    async persistExtraction({ sessionId, slotUpdates, objection, askedFlags, msgId, mock }) {
      const cur = slot.getSession();
      if (!cur) return [];
      const curSlots: Record<string, unknown> =
        cur.slots && typeof cur.slots === "object" && !Array.isArray(cur.slots) ? { ...(cur.slots as Record<string, unknown>) } : {};
      const next = { ...curSlots };
      const applied: string[] = [];
      for (const [k, v] of Object.entries(slotUpdates ?? {})) {
        if (k === "clinicalSuitability" || k === "meta") continue; // 鐵律（同 prisma 同源 guard）
        next[k] = v;
        applied.push(k);
      }
      if (applied.length > 0) slot.setSession({ ...cur, slots: next as ConsultSessionState["slots"] });
      log.debug(
        { scope: "sandbox-consult", applied, objection, flags: askedFlags, msgId, mock },
        "sandbox consult extract（metadata only）"
      );
      void sessionId;
      return applied;
    },
  };
}
