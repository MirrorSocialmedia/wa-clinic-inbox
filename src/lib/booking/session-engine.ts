/**
 * ★ AI Workflow Phase C（cwi-sess-20260824-c1）：slot-filling session engine（總綱 §6.3 C4 — D-2 拍板形態）。
 *
 * pure step function：入 (session, aiOut, slotsData, ctx) 出 (patch, replyText, effects) — 零 IO。
 * ★ 事實鐵律：所有時段/日期/醫生事實句喺呢度砌（deterministic 模板）；
 *   LLM reply 只係語氣句，超 2 句 / 含數字時間 → 棄用只出事實句（兜底）。
 * ★ PII：本檔所有出街文字只含 business metadata（醫生名/日期/時間）— 零病人姓名電話。
 *
 * 簽名偏離（記錄）：
 * - candidateText 加第三參 providers（MD 例文要醫生名，但 MD 簽名冇傳 — 補上）
 * - end() 加 turns/slots 參（MD 簽名 3 參冇法帶 patch 數據 — 補上）
 */
import type { GetSlotsResult } from "@/lib/availability";
import type { SessionAiOutput, SessionSlots } from "@/lib/ai/session-types";
import { SESSION_DEFAULTS, fillVars, type SessionParamsType } from "@/lib/workflow/definitions";

// ★ Phase D：以下常數 = code defaults（保留 export — unit 測試相容）；
//   實際生效值由 StepCtx.params 傳入（runner 讀 WorkflowDefinition ACTIVE row）。
export const MAX_TURNS = SESSION_DEFAULTS.maxTurns;
export const MAX_NO_PROGRESS = SESSION_DEFAULTS.maxNoProgress;
export const CANDIDATE_COUNT = SESSION_DEFAULTS.candidateCount;
export const SESSION_TTL_MS = 24 * 3_600_000;

export type Effect =
  | { kind: "NONE" }
  | { kind: "CREATE_CARD" } // L3：出 BookingRequest 卡
  | { kind: "AUTO_BOOK" } // L4：自動落單（runner 行 confirm-core）
  | { kind: "SEND_FLOW" } // 源離線兜底：改出 Flow
  | { kind: "NOTIFY_STAFF"; noticeKind: "HANDOFF_REQUEST"; title: string }
  | { kind: "URGENT_ESCALATE" };

export interface StepCtx {
  todayHk: string;
  level: "L3" | "L4";
  providers: { apricotId: string; name: string }[];
  pinnedPatient: boolean; // conv.pinnedPatientApricotId != null
  // ★ Phase D：workflow 參數（runner 讀 getParams("booking-session", clinicId) 傳落）。
  // optional — unit 測試唔傳 → SESSION_DEFAULTS（零改）。
  params?: SessionParamsType;
}

export interface StepResult {
  patch: { slots: SessionSlots; status: string; turns: number; noProgress: number };
  replyText: string | null; // 完整出街文字（語氣 + 事實）；null = 唔覆
  effects: Effect[];
}

function notify(title: string): Effect {
  return { kind: "NOTIFY_STAFF", noticeKind: "HANDOFF_REQUEST", title };
}

// ── 日期格式（pure）─────────────────────────────────────────────────────
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const NUM_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

/** "2026-08-26" → "8月26日"（confirmLine 用，MD 格式 M月D日） */
export function fmtDateShort(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

/** "2026-08-26" → "8月26日(三)"（candidateText 用） */
export function fmtDateFull(date: string): string {
  const dt = new Date(`${date}T00:00:00Z`);
  return `${fmtDateShort(date)}(${WEEKDAYS[dt.getUTCDay()]})`;
}

function timeOfDayOf(startTime: string): "MORNING" | "AFTERNOON" | "EVENING" {
  const h = Number(startTime.slice(0, 2));
  if (h < 12) return "MORNING";
  if (h < 18) return "AFTERNOON";
  return "EVENING";
}

// ── step（主入口）───────────────────────────────────────────────────────
export function step(
  session: { slots: SessionSlots; status: string; turns: number; noProgress: number },
  ai: SessionAiOutput,
  slotsData: GetSlotsResult,
  ctx: StepCtx
): StepResult {
  const p = ctx.params ?? SESSION_DEFAULTS;
  const turns = session.turns + 1;

  // ── 0. 逃生口（優先序固定）─────────────────────────────
  if (ai.action === "URGENT")
    return end("HANDOFF", null, [{ kind: "URGENT_ESCALATE" }], turns, session.slots);
  if (ai.action === "HUMAN")
    return end("HANDOFF", "收到，我哋職員好快覆你 🙏", [notify("病人要求真人／需要人手跟進（預約流程中）")], turns, session.slots);
  if (ai.action === "CANCEL")
    return end("CANCELLED", "冇問題，有需要隨時搵我哋預約 🙂", [], turns, session.slots);
  if (turns >= p.maxTurns)
    return end("HANDOFF", p.handoffText, [notify("預約 session 輪數超限 — 請人手接手")], turns, session.slots);

  // ── 1. merge slotUpdates（medical-name→apricotId 對應係 deterministic）──
  const merged = mergeSlots(session.slots, ai.slotUpdates, ctx.providers);
  const progressed = didProgress(session.slots, merged);
  const noProgress = progressed ? 0 : session.noProgress + 1;
  if (noProgress >= p.maxNoProgress)
    return end("HANDOFF", p.handoffText, [notify("預約 session 冇進展 — 請人手接手")], turns, merged);

  // ── 2. 源離線兜底 ───────────────────────────────────────
  if (slotsData.degraded === "NONE")
    return end("ABANDONED", null, [{ kind: "SEND_FLOW" }], turns, merged); // Flow 純收需求變體接力

  // ── 3. CONFIRMING 態：等緊 yes ──────────────────────────
  if (session.status === "CONFIRMING") {
    if (ai.action === "CONFIRM") {
      const eff: Effect[] = ctx.level === "L4" && ctx.pinnedPatient ? [{ kind: "AUTO_BOOK" }] : [{ kind: "CREATE_CARD" }];
      // L4 但未釘住舊客 → 降 L3 出卡（總綱 6.6：新客留人手）
      return {
        patch: { slots: merged, status: "COMPLETED", turns, noProgress: 0 },
        replyText: ctx.level === "L4" && ctx.pinnedPatient ? null : "收到！職員會好快幫你確認 🙂",
        effects: eff,
      }; // AUTO_BOOK 嘅確認訊息由 confirm-core 出（已為你預約…）
    }
    // 改主意（slotUpdates 有新嘢）→ 跌返 ACTIVE 重行收集（下方 4/5 段自然處理）
  }

  // ── 4. 驗證 time（有 date+time 先驗）────────────────────
  const v = validateSelection(merged, slotsData, ctx.todayHk);
  if (v.kind === "invalid-date")
    // 重列候選時清咗無效 date（唔清 → date filter 清晒 rows → 假象「暫無空餘時段」）
    return cont("ACTIVE", merged, turns, noProgress, ai.reply, `唔好意思，${v.why}。${candidateText({ ...merged, date: null }, slotsData, ctx.providers, p)}`);
  if (v.kind === "slot-taken")
    return cont(
      "ACTIVE",
      { ...merged, time: null },
      turns,
      noProgress,
      ai.reply,
      `${p.slotTakenText}${candidateText({ ...merged, time: null }, slotsData, ctx.providers, p)}`
    );

  // ── 5. 齊料 → 入 CONFIRMING；唔齊 → 問一樣 ──────────────
  if (merged.providerApricotId && merged.date && merged.time) {
    return cont("CONFIRMING", merged, turns, 0, ai.reply, confirmLine(merged, p));
  }
  return cont("ACTIVE", merged, turns, noProgress, ai.reply, askNext(merged, slotsData, ctx, p));
}

// ── helpers（pure，全部 unit 測）────────────────────────────────────────

/** providerName → 名單模糊對應（includes / 去空格 / 大小寫不敏感）→ apricotId；對唔到唔寫（保留舊值）。 */
export function mergeSlots(
  old: SessionSlots,
  upd: SessionSlots,
  providers: { apricotId: string; name: string }[]
): SessionSlots {
  const merged: SessionSlots = { ...old };
  if (upd.providerName) {
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const u = norm(upd.providerName);
    const hit = providers.find((p) => {
      const n = norm(p.name);
      return n.length > 0 && (u.includes(n) || n.includes(u));
    });
    if (hit) {
      merged.providerName = hit.name;
      merged.providerApricotId = hit.apricotId;
    }
    // 對唔到 → 保留舊值（null 亦唔覆蓋舊值）
  }
  if (upd.date) merged.date = upd.date;
  if (upd.time) merged.time = upd.time;
  if (upd.timeOfDay) merged.timeOfDay = upd.timeOfDay;
  return merged;
}

/** 任一欄由 null 變有值 / 有值欄改變（含 time 更新）= true。 */
export function didProgress(old: SessionSlots, merged: SessionSlots): boolean {
  const fields: (keyof SessionSlots)[] = ["providerApricotId", "providerName", "date", "time", "timeOfDay"];
  for (const f of fields) {
    const o = old[f] ?? null;
    const m = merged[f] ?? null;
    if (o === null && m !== null) return true;
    if (o !== null && o !== m) return true;
  }
  return false;
}

export type ValidationResult = { kind: "ok" } | { kind: "invalid-date"; why: string } | { kind: "slot-taken" };

/**
 * date < today 或 > 窗口尾 → invalid-date("該日期已過/太遠")
 * date 非開診日（slotsData 無該日任何 row）→ invalid-date("該日冇開診")
 * date+time 齊 → 對 SlotRow(providerApricotId, date, startTime, isOpen)：無匹配 open row → slot-taken
 */
export function validateSelection(slots: SessionSlots, data: GetSlotsResult, today: string): ValidationResult {
  const rows = data.slots ?? [];
  if (slots.date) {
    if (slots.date < today || slots.date > data.window.end)
      return { kind: "invalid-date", why: slots.date < today ? "該日期已過" : "該日期太遠" };
    if (!rows.some((r) => r.date === slots.date)) return { kind: "invalid-date", why: "該日冇開診" };
  }
  if (slots.date && slots.time) {
    const open = rows.some(
      (r) =>
        r.date === slots.date &&
        r.startTime === slots.time &&
        r.isOpen &&
        r.bookedCount === 0 && // MD C4：對 SlotRow(isOpen, bookedCount) — 同 flow precheck（bookedCount>0 = 滿）一致；mock 填位 = isOpen:true+bookedCount:1
        (!slots.providerApricotId || r.providerApricotId === slots.providerApricotId)
    );
    if (!open) return { kind: "slot-taken" };
  }
  return { kind: "ok" };
}

/**
 * 揀 ≤CANDIDATE_COUNT 個最近 open slot（filter 已揀 provider/date/timeOfDay），砌候選文字。
 * degraded STALE_* 嘅免責尾句由 caller 處理（見 step 註）— 呢度保持 pure 定死。
 */
export function candidateText(
  slots: SessionSlots,
  data: GetSlotsResult,
  providers: { apricotId: string; name: string }[],
  p: SessionParamsType = SESSION_DEFAULTS
): string {
  const rows = data.slots ?? [];
  const nameOf = (apricotId: string) => providers.find((pr) => pr.apricotId === apricotId)?.name ?? "";
  const cands = rows
    .filter((r) => r.isOpen && r.bookedCount === 0) // 已滿位（bookedCount>0）唔入候選 — 同 validateSelection/flow precheck 一致
    .filter((r) => !slots.providerApricotId || r.providerApricotId === slots.providerApricotId)
    .filter((r) => !slots.date || r.date === slots.date)
    .filter((r) => !slots.timeOfDay || timeOfDayOf(r.startTime) === slots.timeOfDay)
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
    .slice(0, p.candidateCount);
  if (cands.length === 0) return "而家暫無空餘時段，你可以換一日，或者職員會跟你聯絡 🙏";
  const lines = cands.map((r, i) => `${NUM_EMOJI[i]} ${fmtDateFull(r.date)} ${r.startTime} ${nameOf(r.providerApricotId)}`);
  // degraded STALE_* → 照行 + 免責尾句（MD C4）
  const staleNote =
    data.degraded === "STALE_SOURCE" || data.degraded === "STALE_CACHE" ? p.staleDisclaimer : "";
  return `${p.candidateHeader}\n${lines.join("\n")}\n${p.candidateFooter}${staleNote}`;
}

/** 「同你確認一次：{M月D日} {HH:mm} {醫生名}，啱唔啱？」— 文案 params 化（fillVars deterministic）。 */
export function confirmLine(slots: SessionSlots, p: SessionParamsType = SESSION_DEFAULTS): string {
  return fillVars(p.confirmText, {
    date: fmtDateShort(slots.date ?? ""),
    time: slots.time ?? "",
    provider: slots.providerName ?? "",
  });
}

/** 缺 provider → 問醫生（附名單）；缺 date/time → 候選時段（有 timeOfDay 就 filter 時段）。 */
export function askNext(
  slots: SessionSlots,
  data: GetSlotsResult,
  ctx: StepCtx,
  p: SessionParamsType = ctx.params ?? SESSION_DEFAULTS
): string {
  if (!slots.providerApricotId) {
    const list = ctx.providers.map((pr) => pr.name).join("、");
    return fillVars(p.askProviderText, { providers: list || "（未設定）" });
  }
  return candidateText(slots, data, ctx.providers, p);
}

/**
 * 出街文字組裝（事實鐵律兜底）：
 * llmReply 超 2 句 / 含數字時間（HH:mm）→ 棄用，只出 factText。
 */
export function buildReply(llmReply: string | null, factText: string | null): string | null {
  let tone = typeof llmReply === "string" ? llmReply.trim() : "";
  if (tone && /\d{1,2}:\d{2}/.test(tone)) tone = ""; // 語氣句含數字時間 = 疑似講事實 → 棄用
  if (tone) {
    const sentences = tone.split(/[。！？!?\n]/).filter((s) => s.trim().length > 0);
    if (sentences.length > 2) tone = ""; // 超 2 句 → 棄用
  }
  const parts = [tone, factText ?? ""].filter((s) => s.trim().length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}

function cont(
  status: string,
  slots: SessionSlots,
  turns: number,
  noProgress: number,
  llmReply: string | null,
  factText: string | null
): StepResult {
  return {
    patch: { slots, status, turns, noProgress },
    replyText: buildReply(llmReply, factText),
    effects: [{ kind: "NONE" }],
  };
}

function end(
  status: string,
  replyText: string | null,
  effects: Effect[],
  turns: number,
  slots: SessionSlots
): StepResult {
  return { patch: { slots, status, turns, noProgress: 0 }, replyText, effects };
}
