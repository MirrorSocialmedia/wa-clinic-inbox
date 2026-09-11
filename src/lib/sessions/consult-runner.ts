/**
 * ★ consult v2.1 C3（MD §4）：規則引擎 DB orchestration — 純 transition（consult-engine.ts）之外嘅全部 IO。
 *
 * 職責：
 * 1. `runConsultEngineTurn` — worker 每 consult turn 入口：
 *    - get/create active ConsultSession（C2 守衛：tx 內 Conversation FOR UPDATE + 只准一個 active）
 *      + C1 橋接複製（humanTookOver/lastOutboundText 由 Conversation 過渡欄）+ audit CONSULT_SESSION_CREATE
 *    - conv → session 欄 sync（C2 交接口：C3 起 consult 路徑讀/寫 session 欄；Conversation 欄仍由
 *      send route 寫（非 consult 路徑照舊）— 呢度只做開頭橋接讀取）
 *    - 訊號計算（紅旗 = red-flags.ts FLOOR∪params；指名產品 = isProductUsable 過濾後產品詞匹配）
 *    - 純 transition（consultTransition — 25 行 first match wins）
 *    - persist（stage/terminal/lastAction/nextAction/turnCount/purchaseIntent clamp/objections/
 *      askedSlots/ctaGiven/candidateCategory/slots.meta.priceAskCount）+ audit CONSULT_ENGINE_TURN
 *    - terminal action 對話層 = 轉既有 flow（唔發明）：
 *      HANDOFF_HUMAN（#3/#7/#8）→ 既有 staffNotice HANDOFF_REQUEST + publishNotify 模式
 *      （URGENT_PAIN/COMPLAINT intent 唔重發 — 佢哋自己條路已經發）
 *      PAIN_TRIAGE（#1）→ 現有 PAIN 路徑開 pain session（intent 非 PAIN 時補 staffNotice）
 *      START_BOOKING → caller（worker）轉既有 C6 bookingSession flow（L3/L4 條件鏡照）
 *      END_SESSION（#5/#22）→ follow-up audit placeholder（FollowupTask model 本 repo 未實施 — 記錄）
 *      + 本輪 suppress draft（病人叫停/推搪後唔 auto-reply）
 *    - #4（窗口）/ #6（humanTookOver）= processed:false → session 零寫入（idle 時鐘唔洗；
 *      C1 gate 已處理對話層 + conv.consultGateAction）
 * 2. `runConsultExpireSweep` — #23 48h 無 inbound cron：active session updatedAt 過期 →
 *    terminal EXPIRED + purchaseIntent −0.15（§4.5 第 7 行）+ audit CONSULT_SESSION_EXPIRED +
 *    CONSULT_FOLLOWUP_SCHEDULED（follow-up placeholder）。idleHours env CONSULT_SESSION_IDLE_HOURS
 *    預設 48（Tab 3 UI = C5 範圍 — 呢度只讀預設）。
 *
 * fail-soft 鐵律：engine 失敗唔阻 AI pipeline（對話照落公海/草稿照行）— 只 log + audit。
 * PII：audit 只記 row/rule/action/stage/terminal/turnCount/intentAfter（metadata only，零病人原文）。
 */
import type { PrismaClient, Conversation, Clinic } from "@prisma/client";
import log from "@/lib/log";
import { publishNotify } from "@/lib/notify";
import { applyLexicon, type LexiconEntry } from "@/lib/sessions/lexicon";
import { matchRedFlagTerms } from "@/lib/sessions/red-flags";
import { isProductUsable } from "@/lib/sessions/consult-products";
import {
  computePurchaseIntentDelta,
  consultTransition,
  detectConsultSignals,
  applyIdleExpiry,
  toSessionState,
  CONSULT_IDLE_EXPIRE_HOURS,
  CONSULT_EXPIRE_INTENT_DELTA,
  type ConsultSignals,
  type TransitionResult,
} from "@/lib/sessions/consult-engine";

export interface ConsultTurnInput {
  prisma: PrismaClient;
  /** ai.worker 攞到嘅 conversation（step 3 update 前 snapshot — C1 口徑）。 */
  conv: Conversation;
  clinic: Clinic;
  msg: { id: string; waMessageId: string | null; type: string; body: string | null };
  /** classify 後 intent（fast path 覆蓋後）。 */
  intent: string;
  /** 最終 consult trigger（FLOOR ?? LLM — 非 null 先會入呢度）。 */
  consultTrigger: string;
  /** C1 getWindowState（step 3 update 前 snapshot）。 */
  winOpen: boolean;
  lexicon: LexiconEntry[];
  /** pain-triage params（redFlagTerms 附加詞 — 同 fast path 同一份）。 */
  redFlagParams: { redFlagTerms: Record<string, string[]> };
}

export interface ConsultTurnOutcome {
  sessionId: string | null;
  /** 本輪開咗新 session（C1 trigger → 建）。 */
  created: boolean;
  /** 純 transition 結果（null = engine 未跑 / fail-soft）。 */
  transition: TransitionResult | null;
  /** 便捷：action 字面（null = 冇）。 */
  action: string | null;
  terminal: string | null;
  stage: string;
  /** #5/#22 END_SESSION → 本輪 suppress free-form draft（叫停/推搪後唔 auto-reply）。 */
  suppressDraft: boolean;
  /** 開咗新 session 時嘅 audit（e2e 斷言用）。 */
  createdSessionId: string | null;
}

const NO_OUTCOME: Omit<ConsultTurnOutcome, "sessionId"> = {
  created: false,
  transition: null,
  action: null,
  terminal: null,
  stage: "",
  suppressDraft: false,
  createdSessionId: null,
};

/**
 * 每 consult turn 規則引擎（worker 入口）。fail-soft：任何錯誤 → log + 返回空 outcome（pipeline 照行）。
 */
export async function runConsultEngineTurn(input: ConsultTurnInput): Promise<ConsultTurnOutcome> {
  const { prisma, conv, clinic, msg, intent, consultTrigger, winOpen, lexicon, redFlagParams } = input;
  const t0 = Date.now();
  try {
    const body = msg.body ?? "";
    const canonical = applyLexicon(body, lexicon);

    // ── 1. get/create active session（C2 守衛：tx FOR UPDATE + 只准一個 active） ──
    const session = await prisma.$transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _lock = await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conv.id} FOR UPDATE`;
      const existing = await tx.consultSession.findFirst({ where: { conversationId: conv.id, terminal: null } });
      if (existing) return { session: existing, created: false };
      // terminal 後新 FLOOR 觸發 = 開新 session（C2 守衛口徑：只攔 active — 同 C2 API route 一致）
      const created = await tx.consultSession.create({
        data: {
          conversationId: conv.id,
          clinicId: conv.clinicId,
          workflow: consultTrigger,
          // ★ C1 橋接：session 級副本由 Conversation 過渡欄複製（C3 起 consult 路徑只寫 session 欄）
          humanTookOver: conv.humanTookOver,
          lastOutboundText: conv.lastOutboundText,
        },
      });
      return { session: created, created: true };
    });
    if (session.created) {
      await prisma.auditLog
        .create({
          data: {
            staffId: null, // AI 自動（無 staff 參與）
            action: "CONSULT_SESSION_CREATE",
            entity: "ConsultSession",
            entityId: session.session.id,
            meta: {
              conversationId: conv.id,
              clinicId: conv.clinicId,
              workflow: consultTrigger,
              stage: "DISCOVER",
              bridgedFromConversation: {
                humanTookOver: conv.humanTookOver,
                hasLastOutboundText: conv.lastOutboundText != null,
              },
            } as object,
          },
        })
        .catch((err) => log.warn({ err: String(err) }, "consult-engine: create audit failed（fail-soft）"));
    }

    const row = session.session;
    // ── 2. conv → session 欄 sync（C2 交接口：取過後店員 typed → humanTookOver；AI 發出 → lastOutboundText） ──
    const state0 = toSessionState(row);
    // ★ conv.humanTookOver 係 live source（send route 一置就唔會 reset）— session 欄係副本：
    // 本輪判定用最新值（sync 後先入 transition — #6 要即刻生效，唔好等下輪）。
    const state = state0.humanTookOver || !conv.humanTookOver ? state0 : { ...state0, humanTookOver: true };
    const syncHuman = conv.humanTookOver && !state0.humanTookOver;
    const syncOutbound = conv.lastOutboundText != null && row.lastOutboundText !== conv.lastOutboundText;

    // ── 3. 訊號（純函數 + 外部類） ──
    const rf = matchRedFlagTerms([canonical], redFlagParams);
    const namedProduct = await matchNamedProduct(prisma, conv.clinicId, consultTrigger, `${body} ${canonical}`);
    const priceAskCount = state.slots.meta?.priceAskCount ?? 0;
    const textSignals = detectConsultSignals({
      canonicalText: canonical,
      rawText: body,
      workflow: state.workflow,
      external: {
        redFlagHit: rf.hit,
        complaint: intent === "COMPLAINT",
        windowExpired: !winOpen,
        namedProduct,
      },
    });
    const sig: ConsultSignals = {
      ...textSignals,
      intentDelta: computePurchaseIntentDelta(canonical, body, { priceAskCount, asksPrice: textSignals.asksPrice }),
      idleExpired: false,
    };

    // ── 4. 純 transition（25 行 first match wins） ──
    const transition = consultTransition(state, sig);

    // ── 5. persist（#4/#6 processed:false → 零寫入；row 23 per-turn 唔會到） ──
    let suppressDraft = false;
    if (transition.processed) {
      const updatedObjection = transition.objection;
      const objections = updatedObjection
        ? [...state.objections.filter((o) => o.type !== updatedObjection.type), updatedObjection]
        : state.objections;
      const slots: Record<string, unknown> = { ...state.slots };
      if (sig.asksPrice) slots.meta = { ...(slots.meta as object | undefined), priceAskCount: priceAskCount + 1 };
      const askedSlots =
        transition.askedSlot && !state.askedSlots.includes(transition.askedSlot)
          ? [...state.askedSlots, transition.askedSlot]
          : state.askedSlots;

      const data: Record<string, unknown> = {
        stage: transition.stage,
        turnCount: state.turnCount + 1,
        purchaseIntent: transition.intentAfter,
        lastAction: transition.action,
        nextAction: transition.action,
        objections,
        askedSlots,
        ctaGiven: transition.ctaGiven,
      };
      if (transition.terminal !== null) data.terminal = transition.terminal;
      if (transition.candidateCategory !== null) data.candidateCategory = transition.candidateCategory;
      if (sig.asksPrice) data.slots = slots;
      // 開頭 sync（只喺有寫入時順帶 — 零額外 query）
      if (syncHuman) data.humanTookOver = true;
      if (syncOutbound) data.lastOutboundText = conv.lastOutboundText;
      // 無任何欄改變時仍寫（turnCount 必定變 — processed turn）
      await prisma.consultSession.update({ where: { id: row.id }, data });

      await prisma.auditLog
        .create({
          data: {
            staffId: null,
            action: "CONSULT_ENGINE_TURN",
            entity: "ConsultSession",
            entityId: row.id,
            meta: {
              row: transition.row,
              ruleId: transition.ruleId,
              action: transition.action,
              stage: transition.stage,
              terminal: transition.terminal,
              turnCount: state.turnCount + 1,
              intentAfter: transition.intentAfter,
              processed: true,
              note: transition.note ?? undefined,
              msgId: msg.id,
            } as object,
          },
        })
        .catch((err) => log.warn({ err: String(err) }, "consult-engine: turn audit failed（fail-soft）"));
    } else {
      // processed:false（#4 窗口 / #6 humanTookOver / #23 per-turn 唔會到）— session 零欄寫入（idle 時鐘唔洗）
      if (syncHuman || syncOutbound) {
        await prisma.consultSession
          .update({
            where: { id: row.id },
            data: {
              ...(syncHuman ? { humanTookOver: true } : {}),
              ...(syncOutbound ? { lastOutboundText: conv.lastOutboundText } : {}),
            },
          })
          .catch((err) => log.warn({ err: String(err) }, "consult-engine: sync update failed（fail-soft）"));
      }
      // audit 照寫（processed:false 都留痕 — e2e/audit 斷言 row 4/6；零 PII）
      await prisma.auditLog
        .create({
          data: {
            staffId: null,
            action: "CONSULT_ENGINE_TURN",
            entity: "ConsultSession",
            entityId: row.id,
            meta: {
              row: transition.row,
              action: transition.action,
              processed: false,
              turnCount: state.turnCount,
              msgId: msg.id,
            } as object,
          },
        })
        .catch((err) => log.warn({ err: String(err) }, "consult-engine: turn audit failed（fail-soft）"));
    }

    // ── 6. terminal action 對話層（轉既有 flow — 唔發明） ──
    if (transition.action === "HANDOFF_HUMAN" && transition.terminal === "HANDOFF") {
      // URGENT_PAIN / COMPLAINT 自己條路已經發過 staffNotice — 唔重發
      if (intent !== "URGENT_PAIN" && intent !== "COMPLAINT") {
        await handoffNotice(prisma, conv, `CONSULT 轉人手（row ${transition.row}）`, {
          row: transition.row,
          sessionId: row.id,
          reason: transition.note ?? undefined,
        });
      }
    } else if (transition.action === "PAIN_TRIAGE" && intent !== "PAIN") {
      // 痛症但 classify 非 PAIN（真 LLM 語義差）— 補人手通知（pain session 由 #0 fast path 管）
      await handoffNotice(prisma, conv, "CONSULT 痛症訊號 → PAIN_TRIAGE", { row: 1, sessionId: row.id });
    } else if (transition.action === "END_SESSION") {
      suppressDraft = true; // 叫停/推搪後唔 auto-reply（既有 draft 流唔會再出）
      // 排 follow-up = audit placeholder（FollowupTask model 本 repo 未實施 — 只記錄）
      await prisma.auditLog
        .create({
          data: {
            staffId: null,
            action: "CONSULT_FOLLOWUP_SCHEDULED",
            entity: "ConsultSession",
            entityId: row.id,
            meta: { reason: transition.row === 5 ? "patient-stop" : "decline", row: transition.row, msgId: msg.id } as object,
          },
        })
        .catch((err) => log.warn({ err: String(err) }, "consult-engine: follow-up audit failed（fail-soft）"));
    }

    log.info(
      {
        clinic: clinic.code,
        wamid: msg.waMessageId,
        sessionId: row.id.slice(0, 8),
        row: transition.row,
        rule: transition.ruleId,
        action: transition.action,
        stage: transition.stage,
        terminal: transition.terminal,
        turn: transition.processed ? state.turnCount + 1 : state.turnCount,
        intent: transition.intentAfter,
        created: session.created,
        ms: Date.now() - t0,
      },
      "consult-engine: turn"
    );
    return {
      sessionId: row.id,
      created: session.created,
      transition,
      action: transition.action,
      terminal: transition.terminal,
      stage: transition.stage,
      suppressDraft,
      createdSessionId: session.created ? row.id : null,
    };
  } catch (err) {
    // fail-soft：engine 失敗唔阻 pipeline（對話照行；下輪照試）
    log.error(
      { clinic: clinic.code, conversationId: conv.id, err: err instanceof Error ? err.message : String(err) },
      "consult-engine: turn failed（fail-soft — pipeline 照行）"
    );
    return { sessionId: null, ...NO_OUTCOME };
  }
}

/** 指名產品匹配（#14）— isProductUsable 過濾（鐵律：未批准/停用產品唔入匹配 = 唔會喺任何草稿出現）。 */
async function matchNamedProduct(
  prisma: PrismaClient,
  clinicId: string,
  workflow: string,
  blob: string
): Promise<string | null> {
  try {
    const products = await prisma.consultProduct.findMany({
      where: { workflow, OR: [{ clinicId }, { clinicId: null }] },
    });
    const t = blob.toLowerCase();
    for (const p of products) {
      if (!isProductUsable(p)) continue; // 鐵律 — approvedAt=null / enabled=false 唔入
      for (const term of [p.displayName, p.brand ?? "", p.model ?? "", p.productFamily ?? "", p.code]) {
        const x = term.toLowerCase().trim();
        if (x.length >= 2 && t.includes(x)) return p.code;
      }
    }
    return null;
  } catch (err) {
    log.warn({ err: String(err) }, "consult-engine: named product match failed（fail-soft → null）");
    return null;
  }
}

/** 既有 handoff 模式（同 COMPLAINT 路徑同一份 staffNotice + publishNotify pattern — 唔發明）。 */
async function handoffNotice(
  prisma: PrismaClient,
  conv: Conversation,
  title: string,
  meta: object
): Promise<void> {
  try {
    await prisma.staffNotice.create({
      data: {
        clinicId: conv.clinicId,
        conversationId: conv.id,
        kind: "HANDOFF_REQUEST",
        title,
        meta,
      },
    });
    publishNotify(conv.clinicId, "notice:new", { conversationId: conv.id, kind: "HANDOFF_REQUEST" });
  } catch (err) {
    log.warn({ err: String(err) }, "consult-engine: handoff notice failed（fail-soft）");
  }
}

// ── #23 48h 無 inbound cron（MD §4.2 #23 / §4.5 第 7 行） ─────────────

export interface ConsultExpireSweepResult {
  checked: number;
  expired: number;
  failed: number;
  idleHours: number;
}

/**
 * 48h 無 inbound → active session EXPIRED + purchaseIntent −0.15 + 「排 follow-up」
 * = audit CONSULT_FOLLOWUP_SCHEDULED placeholder（FollowupTask model 本 repo 未實施 — 記錄，唔開 model）。
 * 冪等：已 EXPIRED 嘅唔再碰（terminal=null filter）— 重複跑安全。
 * `idleHours` 參數 > env CONSULT_SESSION_IDLE_HOURS > 預設 48（e2e 可注入）。
 */
export async function runConsultExpireSweep(
  now: Date = new Date(),
  idleHours?: number,
  prisma?: PrismaClient
): Promise<ConsultExpireSweepResult> {
  const db = prisma; // worker 傳入共享 client（e2e 直調用 default）
  const client: PrismaClient = db ?? (await import("@/lib/prisma")).default;
  const hours = idleHours ?? Number(process.env.CONSULT_SESSION_IDLE_HOURS ?? CONSULT_IDLE_EXPIRE_HOURS);
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const stale = await client.consultSession.findMany({ where: { terminal: null, updatedAt: { lt: cutoff } } });
  let expired = 0;
  let failed = 0;
  for (const s of stale) {
    const decision = applyIdleExpiry(toSessionState(s), s.updatedAt, { idleHours: hours, now });
    if (!decision.expired) continue;
    try {
      await client.$transaction([
        client.consultSession.update({
          where: { id: s.id },
          data: { terminal: "EXPIRED", purchaseIntent: decision.intentAfter },
        }),
        client.auditLog.create({
          data: {
            staffId: null,
            action: "CONSULT_SESSION_EXPIRED",
            entity: "ConsultSession",
            entityId: s.id,
            meta: {
              conversationId: s.conversationId,
              clinicId: s.clinicId,
              idleHours: hours,
              intentBefore: s.purchaseIntent,
              intentAfter: decision.intentAfter,
              delta: CONSULT_EXPIRE_INTENT_DELTA,
              row: 23,
            } as object,
          },
        }),
        client.auditLog.create({
          data: {
            staffId: null,
            action: "CONSULT_FOLLOWUP_SCHEDULED",
            entity: "ConsultSession",
            entityId: s.id,
            meta: { reason: "idle-48h", row: 23, conversationId: s.conversationId } as object,
          },
        }),
      ]);
      expired += 1;
    } catch (err) {
      failed += 1;
      log.error({ sessionId: s.id, err: String(err) }, "consult-expire: session failed（下輪 cron 再試）");
    }
  }
  if (expired > 0) log.info({ expired, idleHours: hours }, "consult-expire: sweep done");
  return { checked: stale.length, expired, failed, idleHours: hours };
}
