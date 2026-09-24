"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  Clock,
  ChevronLeft,
  Info,
  Lock,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Send,
  Sparkles,
  StickyNote,
  Users,
  XCircle,
} from "lucide-react";
import type { ConversationItem, DraftInfo, DraftTrace, FollowupSuggestion, MessageItem, NoteReceipt, PatientChip, StaffInfo } from "./types";
import { noteTickState } from "./types";
import { bubbleTime, relTime, windowCountdown } from "./time";

// ★ cwi-followup-v3（MD §2.2）：跟進建議卡 — trigger 顯示名 + 原因行（只食結構化數據，零臨床全文）
const FOLLOWUP_TRIGGER_LABEL: Record<string, string> = {
  BEFORE_APPOINTMENT: "預約提醒",
  AFTER_NO_SHOW: "未到診提醒",
  AFTER_TREATMENT: "術後跟進",
  RECALL_NO_REPEAT: "召回（未回診）",
  QUOTED_NOT_BOOKED: "已報價未預約",
  CONVERSATION_IDLE: "對話空窗",
};

function followupReasonLine(s: FollowupSuggestion): string | null {
  const v = (s.templateVars ?? {}) as Record<string, unknown>;
  const cx = (s.contextJson ?? {}) as Record<string, unknown>;
  const pick = (...ks: string[]): string | null => {
    for (const k of ks) {
      const x = v[k] ?? cx[k];
      if (x != null && x !== "") return String(x);
    }
    return null;
  };
  switch (s.trigger) {
    case "BEFORE_APPOINTMENT": {
      const d = pick("apptDate"); const t = pick("apptTime"); const dr = pick("providerName");
      return [d, t, dr].filter(Boolean).join(" ") || "有預約未提醒";
    }
    case "AFTER_NO_SHOW": {
      const d = pick("apptDate"); const t = pick("apptTime");
      return [d ? `預約 ${d}${t ?? ""}` : null, "未到診"].filter(Boolean).join(" · ");
    }
    case "AFTER_TREATMENT":
      return pick("visitDate") ? `到診 ${pick("visitDate")} · 術後跟進窗` : "治療後跟進窗";
    case "RECALL_NO_REPEAT": {
      const d = pick("lastVisitDate"); const m = pick("intervalMonths");
      return [d ? `上次到診 ${d}` : null, m != null && m !== "" ? `${m} 個月未回` : null].filter(Boolean).join(" · ");
    }
    case "QUOTED_NOT_BOOKED": {
      const d = pick("quoteDate"); const item = pick("item");
      return [d ? `${d} 報價` : null, item].filter(Boolean).join(" · ") || "報價後未預約";
    }
    case "CONVERSATION_IDLE":
      return "客戶一陣未回覆";
    default:
      return null;
  }
}
import { fmtAmt, fmtDateShort } from "@/lib/patient-record-state";
import { BookingCard } from "./booking-card";
import { HoldCard } from "./hold-card";
import { WindowExits } from "./window-exits";

interface Props {
  conversation: ConversationItem | null;
  /** ★ cwi-final S1-3（N-3）：selectedConvId 有值但 row 正經補載（ensureConversationLoaded 進行中）
   *  → skeleton + 返回掣（手機唔好空白 / 唔好「揀一個對話開始」） */
  conversationLoading?: boolean;
  /** 手機返回列表（md 以下顯示 back 掣） */
  onBack: () => void;
  /** 手機撳 header 開詳情 sheet */
  onOpenDetail: () => void;
  messages: MessageItem[];
  hasMore: boolean;
  /** ★ cwi-audit2-20260908 T2（A-3 超額）：中間斷層邊界（createdAt ms）— >250 條 gap 補漏後，
   * 喺第一條 createdAt > 邊界嘅 row（最舊已載入訊息）之上 render 分隔線；null = 無 */
  gapDividerAfterMs?: number | null;
  loadingOlder: boolean;
  onScrollTop: () => void;
  window: { open: boolean; remainingMs: number; tone: string } | null;
  onSend: (body: string, source?: "adopted" | "typed", /** ★ cwi-followup-v3：窗口內 free-form 採用 — 帶跟進建議 task id（server fail-soft claim SUGGESTED→SENT） */ followupTaskId?: string, /** ★ cwi-final S1-13（D-6）：員工實際採用嘅草稿 id（切換過就係切換後嗰個） */ aiDraftId?: string) => Promise<{ ok: boolean; error?: string; templates?: { name: string; language: string }[]; /** cwi-multiclinic-20260903：423 打字保護 — 帶新負責人 id（draft 保留由 composer 行為保證） */ takenOverBy?: string | null; /** ★ cwi-final S0-6：409 FOLLOWUP_NOT_SENDABLE 失效原因 */ notSendableReason?: string }>;
  staffName: string;
  /** Phase 2 + ★ cwi-final S1-13（D-6）：該對話 pending AI 草稿堆疊（新到舊、最多 3）；空陣列 = 無 */
  pendingDrafts: DraftInfo[];
  /** ★ cwi-final S1-13（D-6）：目前展示嘅草稿 index（0 = 最新） */
  draftIndex: number;
  /** ★ cwi-final S1-13（D-6）：切換 index（‹› 掣 / Alt+↑↓） */
  onDraftIndexChange: (i: number) => void;
  /** 採用：寫 audit + （前端）填 composer；返回後 draft 卡保留到發送/棄 */
  onAdopt: (draftId: string) => Promise<void>;
  /** 棄：DELETE draft（→ DISCARDED） */
  onDiscard: (draftId: string) => Promise<void>;
  /** 採用/棄 進行中（disable 掣） */
  draftBusy: boolean;
  /** Phase 3：發 Booking Flow（📅 掣） */
  onSendFlow: () => Promise<{ ok: boolean; error?: string }>;
  /** Phase 3：發 Flow 進行中 */
  flowBusy: boolean;
  /** ★ cwi-final S0-12：G2 閘（SSR 注入）— false → 隱藏 📅 掣 */
  slotClaimEnabled?: boolean;
  /** Phase B：過窗 template 發送（422 後 composer 出揀選 → 撳掣帶 templateName 發）；唔傳 = 功能唔啟用 */
  onSendTemplate?: (name: string) => Promise<{ ok: boolean; error?: string }>;
  /** ★ cwi-inboxfix-20260905（MD §5.3）：標記已作廢 — POST /api/messages/[id]/void（純內部） */
  onVoidMessage: (messageId: string) => Promise<{ ok: boolean; error?: string }>;
  /** ★ H1：自己嘅 staffId（Send Lock 三狀態判定：自己負責/別人負責/unassigned） */
  myStaffId: string;
  /** ★ H1：發內部備註（lock 模式 composer 用；INTERNAL — 唔出 WhatsApp）
   *  ★ H2：mentions = @ 咗嘅 staffId 陣列（後端會再校驗同店 active） */
  onSendNote: (body: string, mentions?: string[]) => Promise<{ ok: boolean; error?: string }>;
  /** ★ H1：〔接手〕— POST assign {toStaffId: self}（lock 翻轉） */
  onTakeover: () => Promise<{ ok: boolean; error?: string }>;
  /** ★ H1：接手進行中（disable 掣） */
  takeoverBusy: boolean;
  /** cwi-multiclinic-20260903（MD A.6.1）：角色（放手掣顯隱 — 現任負責人 ∨ ADMIN） */
  userRole: "ADMIN" | "STAFF" | "SUPERVISOR"; // ★ cwi-routing-20260906 §8
  /** cwi-multiclinic-20260903（MD A.6.1）：〔放手〕— release = assign toStaffId:null（server assertCanAssign 守權限） */
  onRelease?: () => Promise<{ ok: boolean; error?: string }>;
  /** cwi-multiclinic-20260903：放手進行中（disable 掣） */
  releaseBusy?: boolean;
  /** ★ H1：店內 staff 列表（INTERNAL note 顯示發送者名 + ★ H2：@ 自動補全） */
  staff: StaffInfo[];
  /** ★ H2：已讀回執（選中對話嘅 receipts — tick 重算 + hover 已讀名單） */
  readReceipts: NoteReceipt[];
  /** ★ H2：note 進入 viewport → 冪等 POST /api/notes/[id]/read（client 去重，唔重複打） */
  onNoteRead: (messageId: string) => void;
  /** ★ booking-ui（D）：預約卡寫動作完成（代落單/確認/重發 Flow/撤銷）→ parent 重拉對話 + 側欄 */
  onBookingActionDone?: () => void;
  /** ★ P2（cwi-followup-p2）：header〔病人記錄〕— 手機開半屏抽屜 / 桌面切右側欄分頁（parent 依斷點分流） */
  onOpenPatientRecord?: () => void;
  /** ★ cwi-followup-v3（MD §2.2）：該對話現行未處理跟進建議（SUGGESTED）；null = 無 */
  suggestion?: FollowupSuggestion | null;
  /** ★ cwi-followup-v3：過窗採用 — 發 template（POST /api/followups/tasks/:id action=send） */
  onSuggestionSend?: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  /** ★ cwi-followup-v3：跳過 — SKIPPED(MANUAL) + dedupWindowDays 內唔再出 */
  onSuggestionSkip?: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  /** ★ cwi-followup-v3：窗口內 free-form 採用發送成功（composer onSend 回執）→ parent 清建議卡 + 重拉計數 */
  onSuggestionSent?: () => void;
  /** ★ cwi-followup-v3：建議卡送/跳進行中（disable 掣） */
  suggestionBusy?: boolean;
}

// ── ★ H2：@mention helper（純函數 — autocomplete 偵測 + 內文反推 mentions + 高亮渲染） ──

/** 由 cursor 前嘅文字偵測 `@query`（行首或空白後；query 唔含空白/@）→ autocomplete 開關 + @ 插入點。 */
export function detectMention(value: string, caret: number): { query: string; atPos: number } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(^|\s)@([^\s@]*)$/);
  if (!m) return null;
  return { query: m[2], atPos: caret - m[2].length - 1 };
}

/** 由 note 內文反推 mentions（autocomplete 插入格式 `@Name`；長名先 match 避開前綴撞車）。
 *  手打 @Name（唔經 dropdown）都會計入 — 行為一致。 */
export function mentionsFromBody(body: string, staff: StaffInfo[]): string[] {
  if (!body) return [];
  return staff
    .filter((s) => s.name && body.includes(`@${s.name}`))
    .map((s) => s.id);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|\]\\]/g, "\$&");
}

/** note 內文渲染：@Name 高亮（MD §5：note 內文渲染 @B 高亮） */
function renderNoteBody(body: string, staff: StaffInfo[]) {
  const names = staff.map((s) => s.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!body || names.length === 0) return body;
  const re = new RegExp(`@(${names.map(escapeRe).join("|")})`, "g");
  const parts = body.split(re);
  if (parts.length === 1) return body;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="text-ok-text font-semibold whitespace-pre-wrap">
        @{part}
      </span>
    ) : (
      <span key={i} className="whitespace-pre-wrap">
        {part}
      </span>
    )
  );
}

/** status tick（OUT API 訊息）— lucide 版 */
function Ticks({ status, errorCode }: { status: string; errorCode: string | null }) {
  if (status === "FAILED") {
    return (
      <span
        title={`發送失敗${errorCode ? `：${errorCode}` : ""}`}
        className="text-danger-text text-[11px] font-semibold inline-flex items-center gap-0.5"
      >
        <AlertTriangle size={11} strokeWidth={2.75} /> {errorCode}
      </span>
    );
  }
  if (status === "CANCELLED") {
    return (
      <span title="已撤回（未發出 — 病人收唔到）" className="text-t3 text-[11px] inline-flex items-center gap-0.5">
        <XCircle size={11} strokeWidth={2.25} /> 已撤回（未發出）
      </span>
    );
  }
  if (status === "READ") return <CheckCheck size={13} strokeWidth={2.75} className="text-brand-hover" />;
  if (status === "DELIVERED") return <CheckCheck size={13} strokeWidth={2.75} className="text-t3" />;
  if (status === "SENT") return <Check size={13} strokeWidth={2.75} className="text-t3" />;
  if (status === "QUEUED") return <span className="text-t3 text-[11px]">…</span>;
  return null;
}

/** ★ Part F（cwi-raggolden-20260904，F.7）：trace panel 可展開段內容（零 PII — 全 metadata）。 */
function TracePanel({ trace }: { trace: DraftTrace }) {
  const k = trace.knowledge;
  const px = trace.price;
  const rows: { label: string; value: React.ReactNode }[] = [];
  rows.push({
    label: "workflow",
    value: trace.workflow + (trace.paramsVersion ? `（params v${(trace.paramsVersion as Record<string, unknown>)[trace.workflow] ?? "—"}）` : ""),
  });
  if (trace.gates) {
    rows.push({
      label: "自動覆閘",
      value: (
        <span>
          {trace.gates.autoLevel ?? "—"} · {trace.gates.autoSent ? "已自動發" : `blocks: ${trace.gates.blocks?.length ? trace.gates.blocks.join(", ") : "無"}`}
        </span>
      ),
    });
  }
  if (trace.lexicon?.hits?.length) rows.push({ label: "lexicon 命中", value: trace.lexicon.hits.join(", ") });
  rows.push({
    label: "知識檢索",
    value: k ? (
      <span>
        {k.ran ? (k.picked?.length ? `引用 ${k.picked.length} 條：` : `無引用（${k.skipped ?? "NONE"}）`) : "未行（目錄空/媒體）"}
        {k.picked?.map((d) => (
          <span key={d.id} className="ml-1 inline-block bg-brand-soft text-brand-text rounded px-1 py-0.5 text-[10px] mr-1">
            {d.title}（{d.kind}）
          </span>
        ))}
        {k.discarded ? <span className="text-danger"> · 幻覺 id 丟棄 {k.discarded}</span> : null} · {k.latencyMs ?? 0}ms
      </span>
    ) : (
      "—"
    ),
  });
  if (trace.impression) rows.push({ label: "impression", value: trace.impression });
  if (px) {
    rows.push({
      label: "price-guard",
      value: (
        <span>
          {px.triggered ? `報價鏈觸發（doc: ${px.docId ?? "無"}）` : "未觸發"}
          {px.guard.blocked && <span className="text-danger"> · 金額被擋（人手提示版）</span>}
          {px.guard.outOfRange && <span className="text-danger"> · 金額出範圍</span>}
          {px.guard.disclaimerAppended && <span className="text-ok-text"> · disclaimer 已自動附加</span>}
        </span>
      ),
    });
  }
  if (trace.latencyMs !== undefined) rows.push({ label: "latency", value: `${trace.latencyMs}ms` });
  return (
    <div className="px-2.5 pb-2 space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex gap-2 text-[10.5px] leading-4">
          <span className="w-20 shrink-0 text-t3">{r.label}</span>
          <span className="text-t2 min-w-0 break-words">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function mediaSrc(mediaPath: string | null): string | null {
  if (!mediaPath) return null;
  const base = mediaPath.split("/").pop() ?? mediaPath;
  return `/api/media/${encodeURIComponent(base)}`;
}

function initialOf(c: ConversationItem): string {
  const n = c.contact?.profileName?.trim();
  return n ? n.charAt(0) : "?";
}

// ── cwi-inboxfix-20260905（MD §5.3）：「標記已作廢 / 更正草稿」 ──
// ★ cwi-notify-fix-20260907（§7 撤回作廢）：8 秒撤回窗口 + 倒數掣整節剷（send job 即刻送）。
// 過窗「撤回」menu item 一併剷（server undo route 已刪）；保留 ⋯ 掣（作廢 / 更正草稿）。
/** 更正草稿模板（MD §5.3：一鍵插入更正草稿） */
const CORRECTION_DRAFT = "對唔住，上一句發錯咗，正確嘅係：";

function UndoControls({
  m,
  onVoid,
  onInsertCorrection,
}: {
  m: MessageItem;
  onVoid: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onInsertCorrection: (body: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setBusy] = useState(false); // B-4 清走：busy 值從未讀（只 setBusy 用）

  return (
    <span className="relative inline-flex items-center gap-1">
      {notice && <span className="text-[10px] text-warn-text">{notice}</span>}
      {m.voidedAt && (
        <span title="已作廢（內部標記 — 病人端 WhatsApp 照見原文，以更正訊息為準）" className="text-[10px] text-warn-text">
          ⚠ 已作廢
        </span>
      )}
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="text-[11px] text-t3 hover:text-t1 opacity-0 group-hover:opacity-100 transition-opacity"
        title="訊息操作（作廢 / 更正）"
      >
        ⋯
      </button>
      {menuOpen && (
        <span className="absolute right-0 bottom-5 z-20 flex flex-col bg-panel border border-line rounded-lg shadow-lg overflow-hidden text-[11px] w-44">
          {!m.voidedAt && (
            <button
              onClick={async () => {
                setMenuOpen(false);
                setBusy(true);
                const r = await onVoid(m.id);
                setBusy(false);
                if (!r.ok) setNotice(r.error ?? "標記失敗");
              }}
              className="px-2.5 py-1.5 text-left hover:bg-line/30"
            >
              標記為已作廢
            </button>
          )}
          <button
            onClick={() => {
              setMenuOpen(false);
              onInsertCorrection(m.body ? `${CORRECTION_DRAFT}\n（原句）${m.body}` : CORRECTION_DRAFT);
            }}
            className="px-2.5 py-1.5 text-left hover:bg-line/30"
          >
            插入更正草稿
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * 對話欄（MD §6.4）v2 — WhatsApp 式氣泡 + brand AI 草稿卡。
 * 邏輯同 v1 完全一樣（auto-fill draft / scroll pin / 分頁 / flow / booking）。
 */
export function ChatPane(p: Props) {
  const [draft, setDraft] = useState("");
  // ★ cwi-final S1-13（D-6）：堆疊入目前展示緊嘅卡（parent 已 clamp index）
  const shownDraft = p.pendingDrafts[p.draftIndex] ?? null;
  const [sending, setSending] = useState(false);
  const [sendingNote, setSendingNote] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  // Phase B：過窗 422 後嘅 template 揀選（server 回嘅 APPROVED+UTILITY 名單）
  const [templateOptions, setTemplateOptions] = useState<{ name: string; language: string }[] | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  // ★ cwi-inboxfix-20260905（MD §5.1）：Flow/template 發送確認彈窗（病人名 + 內容）— 純文字訊息唔使確認
  const [outConfirm, setOutConfirm] = useState<{ to: string; desc: string; run: () => void } | null>(null);
  // cwi-window-20260901（P2）：COPY_ONLY 草稿「複製」掣 feedback（「已複製」2s）
  const [copiedDraft, setCopiedDraft] = useState(false);
  // ★ P2（cwi-followup-p2）：header 病人 chip（summary=1 輕量；fail-soft — 無病人/離線 = 無 chip）
  const [patientChip, setPatientChip] = useState<PatientChip | null>(null);
  // ★ cwi-inboxfix-20260905（MD §2）：AI trace 收埋做 ⓘ 掣 — 撳先展開（內容唔變）
  const [traceOpen, setTraceOpen] = useState(false);
  // ★ Part F（cwi-raggolden-20260904，F.5）：inbox「加入測試集」— IN 文字 bubble hover 掣 → 預填彈窗
  //   （server-side deid + AI 當時判斷）→ 員工揀正確 intent/紅旗/自動覆 → POST /api/golden-cases
  const [goldenMsgId, setGoldenMsgId] = useState<string | null>(null);
  const [goldenPrefill, setGoldenPrefill] = useState<{
    clinicId: string;
    utterance: string;
    contextBefore: string[];
    aiJudgment: { intent: string; needsHuman: boolean; urgency: string };
    expectDocIds: string[];
    hasDraft: boolean;
  } | null>(null);
  const [goldenForm, setGoldenForm] = useState<{ utterance: string; expectIntent: string; expectRedFlag: boolean; expectAutoOk: boolean; expectDocIds: string; note: string } | null>(null);
  const [goldenErr, setGoldenErr] = useState<string | null>(null);
  const [goldenBusy, setGoldenBusy] = useState(false);
  const openGolden = useCallback(async (messageId: string) => {
    setGoldenMsgId(messageId);
    setGoldenErr(null);
    setGoldenPrefill(null);
    setGoldenForm(null);
    try {
      const r = await fetch(`/api/golden-cases/prefill?messageId=${encodeURIComponent(messageId)}`, { credentials: "include" });
      const j = (await r.json().catch(() => ({}))) as NonNullable<typeof goldenPrefill> & { error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setGoldenPrefill(j);
      setGoldenForm({
        utterance: j.utterance,
        expectIntent: j.aiJudgment?.intent && ["BOOKING_REQUEST","QUESTION","URGENT_PAIN","COMPLAINT","OUT_OF_SCOPE","OTHER"].includes(j.aiJudgment.intent) ? j.aiJudgment.intent : "QUESTION",
        expectRedFlag: j.aiJudgment?.urgency === "HIGH" || j.aiJudgment?.intent === "URGENT_PAIN",
        expectAutoOk: false,
        expectDocIds: (j.expectDocIds ?? []).join(", "),
        note: "",
      });
    } catch (e) {
      setGoldenErr(e instanceof Error ? e.message : "prefill failed");
    }
  }, []);
  const submitGolden = useCallback(async () => {
    if (!goldenPrefill || !goldenForm) return;
    setGoldenErr(null);
    setGoldenBusy(true);
    try {
      const r = await fetch("/api/golden-cases", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinicId: goldenPrefill.clinicId,
          utterance: goldenForm.utterance,
          contextBefore: goldenPrefill.contextBefore,
          expectIntent: goldenForm.expectIntent,
          expectRedFlag: goldenForm.expectRedFlag,
          expectAutoOk: goldenForm.expectAutoOk,
          expectDocIds: goldenForm.expectDocIds.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
          note: goldenForm.note || null,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setGoldenMsgId(null);
    } catch (e) {
      setGoldenErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setGoldenBusy(false);
    }
  }, [goldenPrefill, goldenForm]);
  // cwi-schedv2-20260903（D.3）：過窗三出路 → 共享組件 <WindowExits/>（喺 composer 分支渲染，markup 不變）
  // ★ cwi-multiclinic-20260903（MD A.6.1）：〔放手〕兩段確認 — 第一次撳 arm（3 秒內再撳一次先真 release）
  const [releaseArmed, setReleaseArmed] = useState(false);
  useEffect(() => {
    setReleaseArmed(false);
  }, [p.conversation?.id]);
  useEffect(() => {
    if (!releaseArmed) return;
    const t = setTimeout(() => setReleaseArmed(false), 3000);
    return () => clearTimeout(t);
  }, [releaseArmed]);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const canRelease =
    !!p.conversation?.assigneeId &&
    (p.conversation.assigneeId === p.myStaffId || p.userRole === "ADMIN") &&
    !!p.onRelease;
  // ★ Phase E（cwi-ai-20260825-t5）：header「⋯」menu — 標記投訴 / AI 錯誤（即時記帳；STAFF 可用）
  const [flagMenuOpen, setFlagMenuOpen] = useState(false);
  const [flagBusy, setFlagBusy] = useState(false);
  const [flagMsg, setFlagMsg] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  const autoFilledDraftRef = useRef<string | null>(null);
  // ★ cwi-final S1-13（D-6）：最後一次由草稿填入 composer 嘅原文 — 切換時判定「有冇改字」用
  const filledTextRef = useRef<string | null>(null);
  // ★ consult v2.1 C5（MD §8.4）：composer 內嘅文字係咪由 AI 草稿「採用」嚟（auto-fill / 採用並編輯）。
  //   發送時 source = adopted（採用並編輯，含改動）vs typed（自己由零打字 → humanTookOver）。
  const adoptedDraftRef = useRef<string | null>(null);
  // ★ cwi-followup-v3：composer 內文字係咪由跟進建議「採用並編輯」嚟 — 發送時帶 followupTaskId（claim SENT）
  const adoptedFollowupRef = useRef<string | null>(null);
  // ★ H2：@ autocomplete（note composer）— {query, atPos} = 偵測到嘅 @ 後字串 + @ 字位置
  const [mentionState, setMentionState] = useState<{ query: string; atPos: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // ★ H2：note auto-read 去重（per conversation；server 側本來就冪等，呢度只係慳 request）
  const noteReadSentRef = useRef<Set<string>>(new Set());
  // 穩定 callback ref（observer 唔好跟住每次 render 重綁 inline fn）
  const onNoteReadRef = useRef(p.onNoteRead);
  useEffect(() => {
    onNoteReadRef.current = p.onNoteRead;
  });

  // ★ cwi-final S1-1e（=S1-6）render 防呆：濾走「別對話」訊息（慢回應 race 殘留）—
  //   layer 1（async guard）之後嘅最後一道防線；同 conversation 之外嘅 row 唔 render。
  const visible = useMemo(
    () => p.messages.filter((m) => m.conversationId === p.conversation?.id),
    [p.messages, p.conversation?.id]
  );
  useEffect(() => {
    if (visible.length !== p.messages.length) {
      // eslint-disable-next-line no-console -- v2 §3 race 留痕（N>0 = 捉到一次 foreign 殘留）
      console.warn("[rt] foreign messages dropped", { kept: visible.length, total: p.messages.length });
    }
  }, [visible.length, p.messages.length]);

  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  useEffect(() => {
    setDraft("");
    setSendError(null);
    setMentionState(null);
    setMentionIdx(0);
    setTemplateOptions(null);
    pinnedRef.current = true;
    autoFilledDraftRef.current = null;
    filledTextRef.current = null; // ★ cwi-final S1-13（D-6）：換對話 → 填入基準重置
    adoptedFollowupRef.current = null; // ★ cwi-followup-v3：換對話 → 建議採用旗清掉
    noteReadSentRef.current = new Set();
  }, [p.conversation?.id]);

  // ★ H2：note 進入 viewport → 冪等 POST read（IntersectionObserver；只 observe INTERNAL note 氣泡）
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const noteId = (en.target as HTMLElement).dataset.noteId;
          if (!noteId || noteReadSentRef.current.has(noteId)) continue;
          noteReadSentRef.current.add(noteId);
          onNoteReadRef.current(noteId);
          obs.unobserve(en.target);
        }
      },
      { root: el, threshold: 0.5 }
    );
    el.querySelectorAll<HTMLElement>("[data-note-id]").forEach((n) => obs.observe(n));
    return () => obs.disconnect();
  }, [visible, p.conversation?.id]);

  useEffect(() => {
    if (!shownDraft) {
      autoFilledDraftRef.current = null;
      setCopiedDraft(false);
      return;
    }
    if (autoFilledDraftRef.current !== shownDraft.id) setCopiedDraft(false);
    if (autoFilledDraftRef.current === shownDraft.id) return;
    // ★ cwi-final S1-13（D-6）：auto-fill 只對 index 0（最新）且非 stale — 舊卡唔會蓋住 composer
    if (p.draftIndex !== 0 || shownDraft.stale) return;
    // cwi-window-20260901（P2）：COPY_ONLY 過窗草稿唔入 composer（發唔出 — 只准複製去手機 App）
    if (shownDraft.mode === "COPY_ONLY") return;
    // ★ H1：lock 模式（assignee 係其他人）唔好 auto-fill AI 草稿入 composer — 嗰度係內部備註欄
    const locked = !!p.conversation?.assigneeId && p.conversation?.assigneeId !== p.myStaffId;
    if (locked) return;
    if (draft.trim() === "") {
      setDraft(shownDraft.draftText);
      autoFilledDraftRef.current = shownDraft.id;
      filledTextRef.current = shownDraft.draftText; // ★ cwi-final S1-13：填入基準（改字判定）
      adoptedDraftRef.current = shownDraft.id; // ★ C5 §8.4：auto-fill = 採用（source: adopted）
    }
  }, [shownDraft, p.draftIndex, draft, p.conversation?.assigneeId, p.myStaffId]);

  // ★ C5 §8.4：換對話 → 採用旗清掉（composer 狀態唔會跨對話沿用）
  useEffect(() => {
    adoptedDraftRef.current = null;
    adoptedFollowupRef.current = null; // ★ cwi-final S0-4（N-10.3）：跟進採用旗同行清掉（主 reset effect 已清過，呢度跟 adoptedDraftRef 對齊）
  }, [p.conversation?.id]);

  // ★ P2（cwi-followup-p2）：對話切換 → 重拉 summary chip（fail-soft：404/403/離線/無病人 = 無 chip，唔阻 header）
  //   （必喺 early return 之前 — 條件 hook 會 break React hook order）
  useEffect(() => {
    let on = true;
    setPatientChip(null);
    const conv = p.conversation;
    if (!conv) return;
    fetch(`/api/conversations/${conv.id}/patient-record?summary=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!on) return;
        if (!j?.patient) {
          setPatientChip(null);
          return;
        }
        setPatientChip({
          patientCode: j.patient.patientCode ?? null,
          customerType: j.patient.customerType === "returning" ? "returning" : "new",
          osAmt: j.balance?.balance.osAmt ?? null,
          lastVisitDate: j.patient.lastVisitDate ?? null,
        });
      })
      .catch(() => {
        if (on) setPatientChip(null);
      });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.conversation?.id]);

  if (!p.conversation) {
    // ★ cwi-final S1-3（N-3）：對話 row 補載中（深連結 / push / bell 指向唔喺列表嘅對話）— skeleton + 返回掣。
    //   只係「正補載」先入呢度（flag 由 caller 控制）：失敗出 notice 後 flag 即清 → 落返下面空狀態，唔會卡死 spinner。
    if (p.conversationLoading) {
      return (
        <section className="flex-1 min-w-0 flex flex-col min-h-0 bg-canvas" data-testid="s13-conv-loading">
          <div className="h-[52px] shrink-0 bg-panel border-b border-line flex items-center px-2 md:px-4">
            <button onClick={p.onBack} aria-label="返回列表" className="md:hidden p-1 -ml-1 text-brand-text">
              <ChevronLeft size={20} />
            </button>
            <div className="h-5 w-40 rounded bg-panel-2 animate-pulse" />
          </div>
          <div className="flex-1 space-y-4 p-4 overflow-hidden">
            <div className="h-10 w-1/2 self-start rounded-xl bg-panel-2 animate-pulse" />
            <div className="h-10 w-3/5 self-end rounded-xl bg-panel-2 animate-pulse" />
            <div className="h-5 w-1/3 self-start rounded bg-panel-2 animate-pulse" />
            <div className="h-10 w-2/3 self-start rounded-xl bg-panel-2 animate-pulse" />
          </div>
        </section>
      );
    }
    return (
      <section className="flex-1 min-w-0 hidden md:flex items-center justify-center bg-canvas">
        <div className="text-center text-t3 text-sm flex flex-col items-center gap-2">
          <MessageCircle size={36} strokeWidth={2.75} />
          <div>揀一個對話開始</div>
        </div>
      </section>
    );
  }

  const c = p.conversation;
  // ★ H1 Send Lock 三狀態：locked = 有負責人且唔係自己（composer 轉內部備註模式）
  const locked = !!c.assigneeId && c.assigneeId !== p.myStaffId;
  // ★ cwi-routing-20260906 §8：SUPERVISOR 覆唔到客 — composer 轉唯讀提示（內部備註照發）
  const readOnly = p.userRole === "SUPERVISOR";
  // cwi-window-20260901（P2）：COPY_ONLY 過窗草稿（發唔出 — 只准複製去手機 App）
  const isCopyOnly = shownDraft?.mode === "COPY_ONLY";

  // ★ cwi-final S1-13（D-6）：堆疊切換（‹› 掣 / Alt+↑↓）— 改咗字先撳 → 確認 dialog（取消 = 文字保留、index 不變）
  function switchDraft(i: number) {
    const target = p.pendingDrafts[i];
    if (!target) return;
    const edited = draft.trim() !== "" && draft !== filledTextRef.current;
    if (edited && !window.confirm("你改緊嘅內容會被換走，確定切換？")) return;
    p.onDraftIndexChange(i);
    if (target.mode !== "COPY_ONLY" && !locked) {
      setDraft(target.draftText);
      filledTextRef.current = target.draftText;
      adoptedDraftRef.current = target.id; // ★ 發送時帶呢個 id
    }
  }
  const assigneeName = c.assigneeName ?? null;
  const staffNameById = new Map(p.staff.map((s) => [s.id, s.name]));
  // ★ cwi-audit2-20260908 T2（A-3 超額）：中間斷層分隔線位置 = 第一條 createdAt > 邊界嘅 row
  //   （messages 已按 createdAt 主序排 → findIndex 直接得）；無匹配 = 唔 render。
  const gapDividerIdx =
    p.gapDividerAfterMs == null
      ? -1
      : visible.findIndex((m) => new Date(m.createdAt).getTime() > (p.gapDividerAfterMs as number));
  // ★ H2：@ autocomplete candidates（query 前綴 match；長名先；cap 8 — 輕量計算，staff 陣列細，唔使 memo）
  const mentionCandidates =
    mentionState === null
      ? []
      : p.staff
          .filter((s) => s.name && s.name.toLowerCase().startsWith(mentionState.query.toLowerCase()))
          .sort((a, b) => b.name.length - a.name.length)
          .slice(0, 8);

  /** 揀中 candidate → 把 `@query` 換做 `@Name `（cursor 跟落去） */
  function applyMention(name: string) {
    const el = taRef.current;
    if (!mentionState || !el) return;
    const caret = el.selectionStart ?? draft.length;
    const before = draft.slice(0, mentionState.atPos);
    const after = draft.slice(caret);
    const next = `${before}@${name} ${after}`;
    setDraft(next);
    setMentionState(null);
    const pos = before.length + name.length + 2;
    requestAnimationFrame(() => el.setSelectionRange(pos, pos));
  }

  const windowChipCls =
    c.window.tone === "red"
      ? "bg-danger-soft text-danger-text"
      : c.window.tone === "yellow"
        ? "bg-warn-soft text-warn-text"
        : "bg-ok-soft text-ok-text";

  // ── cwi-inboxfix-20260905（MD §5.1）：外發確認層（Flow/template）─────────────
  function requireOutConfirm(desc: string, run: () => void) {
    setOutConfirm({ to: c.contact?.profileName?.trim() || "病人", desc, run });
  }
  function runOutConfirm() {
    const cf = outConfirm;
    if (!cf) return;
    setOutConfirm(null);
    cf.run();
  }

  async function sendFlow() {
    if (flowError) setFlowError(null);
    const r = await p.onSendFlow();
    if (!r.ok) setFlowError(r.error ?? "發送失敗");
  }

  async function sendNote() {
    const body = draft.trim();
    if (!body || sendingNote || !c) return;
    // ★ H2：mentions 由內文 @Name token 反推（autocomplete 同手打行為一致）
    const mentions = mentionsFromBody(body, p.staff);
    setSendingNote(true);
    setSendError(null);
    const r = await p.onSendNote(body, mentions);
    if (!r.ok) setSendError(r.error ?? "內部備註發送失敗");
    else {
      setDraft("");
      setMentionState(null);
    }
    setSendingNote(false);
  }

  async function send() {
    const body = draft.trim();
    if (!body || sending || !c) return;
    setSending(true);
    setSendError(null);
    // ★ C5 §8.4：source 標記 — 由草稿採用嚟（auto-fill/採用並編輯，含改動）= adopted；
    //   自己由零打字 = typed（server 置 humanTookOver → 側欄「AI 已暫停」）。
    // ★ cwi-final S0-4（N-6）：窗口內跟進建議「採用並編輯」（free-form）同样係 adopted —
    //   採用時建議文案已填 composer，用戶只是細調 ≠ 由零自己打字（唔該置 humanTookOver）。
    const source: "adopted" | "typed" =
      adoptedDraftRef.current || adoptedFollowupRef.current ? "adopted" : "typed";
    // ★ cwi-followup-v3：窗口內 free-form 採用 → 帶 followupTaskId（server fail-soft claim SUGGESTED→SENT）
    const followupTaskId = adoptedFollowupRef.current;
    // ★ cwi-final S1-13（D-6）：員工實際採用嘅草稿 id（切換過就係切換後嗰個）→ server 準確連結
    const aiDraftId = adoptedDraftRef.current ?? undefined;
    const r = await p.onSend(body, source, followupTaskId ?? undefined, aiDraftId);
    if (!r.ok) {
      // ★ cwi-final S0-6：409 FOLLOWUP_NOT_SENDABLE — 建議已失效（task 已同步轉態）→
      //   清採用旗 + 刷新建議卡；**文字保留喺 composer**（員工再撳發送 = 普通訊息）。
      if (r.error === "FOLLOWUP_NOT_SENDABLE") {
        adoptedFollowupRef.current = null;
        setSendError(`呢條跟進建議已失效（${r.notSendableReason ?? "未知"}）`);
        p.onSuggestionSent?.();
      } else {
        // cwi-multiclinic-20260903（MD A.6.2）：423 打字保護 — 文字保留（setDraft 唔郁）；
        // toast「{name} 已接手呢個對話」由 parent（inbox-client）發出；header 負責人名 optimistic 更新。
        setSendError(r.takenOverBy ? "對話已被接手 — 你而家只可發內部備註" : r.error ?? "發送失敗");
        // Phase B：過窗 422 帶 templates 名單 → 出 template 揀選
        if (r.templates && r.templates.length > 0) setTemplateOptions(r.templates);
      }
    } else {
      setDraft("");
      adoptedDraftRef.current = null;
      adoptedFollowupRef.current = null;
      // ★ cwi-final S0-4（N-10.2）：只喺今次有帶 followupTaskId（真係發送咗跟進採用）先清卡 —
      //   自己打字發送唔應該清咗張未送嘅建議卡（T607）。
      if (followupTaskId) p.onSuggestionSent?.();
    }
    setSending(false);
  }

  async function sendTemplate(name: string) {
    setTemplateBusy(true);
    setSendError(null);
    const r = await p.onSendTemplate!(name);
    if (!r.ok) {
      setSendError(r.error ?? "template 發送失敗");
    } else {
      setTemplateOptions(null);
    }
    setTemplateBusy(false);
  }

  /** ★ cwi-followup-v3：過窗採用 — 發 template（engine sendFollowupTask — sentVia=AI_ADOPTED） */
  async function suggestionSend() {
    const s = p.suggestion;
    if (!s || !p.onSuggestionSend) return;
    const r = await p.onSuggestionSend(s.id);
    if (!r.ok) setSendError(r.error ?? "template 發送失敗");
    else setSendError(null);
  }

  /** ★ cwi-followup-v3：跳過 — SKIPPED(MANUAL) + dedupWindowDays 內唔再出 */
  async function suggestionSkip() {
    const s = p.suggestion;
    if (!s || !p.onSuggestionSkip) return;
    const r = await p.onSuggestionSkip(s.id);
    if (!r.ok) setSendError(r.error ?? "跳過失敗");
    else setSendError(null);
  }

  // ★ Phase E：標記投訴 / AI 錯誤 → POST /flag（24h 內冪等 no-op）
  async function flag(kind: "COMPLAINT" | "AI_ERROR") {
    if (!c) return;
    setFlagBusy(true);
    setFlagMsg(null);
    try {
      const res = await fetch(`/api/conversations/${c.id}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setFlagMsg(j.message ?? `標記失敗（HTTP ${res.status}）`);
      else setFlagMsg(j.counted ? "已標記（計入本週統計）" : "24h 內已標記（冇重複計）");
    } catch {
      setFlagMsg("網絡錯誤");
    } finally {
      setFlagBusy(false);
    }
  }

  return (
    <section className="flex-1 min-w-0 flex flex-col min-h-0 bg-canvas">
      {/* header：avatar + contact + 窗口 chip */}
      <div className="h-[52px] shrink-0 bg-panel border-b border-line flex items-center gap-2 md:gap-2.5 px-2 md:px-4">
        <button onClick={p.onBack} aria-label="返回列表" className="md:hidden p-1 -ml-1 text-brand-text">
          <ChevronLeft size={20} />
        </button>
        <button
          onClick={p.onOpenDetail}
          className="flex items-center gap-2.5 min-w-0 text-left lg:pointer-events-none"
          aria-label="開啟聯絡人詳情"
        >
          <div className="w-[38px] h-[38px] rounded-full bg-brand text-panel flex items-center justify-center text-[15px] font-medium shrink-0">
            {initialOf(c)}
          </div>
          <div className="min-w-0">
            <div className="font-display text-[17px] leading-tight text-t1 truncate">
              {c.contact?.profileName || "未命名聯絡人"}
            </div>
            {c.contact?.waId && <div className="text-[11px] text-t3">{c.contact.waId}</div>}
            {/* ★ P2（cwi-followup-p2 §3.1）+ v3：病人 chip — patientCode·舊客/新客 + 未結餘額（中性灰，>0 先顯）+ 上次到診 */}
            {patientChip ? (
              <div className="flex items-center gap-1 flex-wrap" data-e2e="p2-chip-row">
                <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-panel-2 text-t2" data-e2e="p2-chip-code">
                  {patientChip.patientCode ?? "—"} · {patientChip.customerType === "returning" ? "舊客" : "新客"}
                </span>
                {patientChip.osAmt != null && patientChip.osAmt > 0 ? (
                  <span
                    className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-panel-2 text-t2"
                    data-e2e="p2-chip-os"
                  >
                    未結餘額 {fmtAmt(patientChip.osAmt)}
                  </span>
                ) : null}
                {patientChip.lastVisitDate ? (
                  <span className="text-[10px] text-t3" data-e2e="p2-chip-lastvisit">
                    上次到診 {fmtDateShort(patientChip.lastVisitDate)}
                  </span>
                ) : null}
              </div>
            ) : null}
            {assigneeName && (
              <div className={`text-[10px] inline-flex items-center gap-0.5 ${locked ? "text-warn-text" : "text-t3"}`}>
                <Lock size={9} />
                負責人：{c.assigneeId === p.myStaffId ? "你" : assigneeName}
              </div>
            )}
          </div>
        </button>
        {/* ★ P2（cwi-followup-p2 §3.1）：〔病人記錄〕入口 — 手機開半屏抽屜 / 桌面切右側欄分頁 */}
        <button
          data-e2e="p2-open-record"
          onClick={() => p.onOpenPatientRecord?.()}
          className="px-2.5 py-1 rounded-full text-[11px] border border-line text-brand-text bg-brand-soft hover:opacity-80 whitespace-nowrap"
        >
          病人記錄
        </button>
        {/* ★ Phase E：「⋯」menu — 標記投訴 / 標記 AI 錯誤（前線先見到問題） */}
        <div className="relative">
          <button
            onClick={() => {
              setFlagMenuOpen(!flagMenuOpen);
              setFlagMsg(null);
            }}
            aria-label="更多操作"
            className="p-1.5 rounded-full text-t2 hover:bg-black/[.04]"
          >
            <MoreHorizontal size={16} strokeWidth={2.75} />
          </button>
          {flagMenuOpen ? (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setFlagMenuOpen(false)} />
              <div className="absolute right-0 top-9 z-20 w-44 bg-panel border border-line rounded-2xl shadow-lg py-1">
                {flagMsg ? <p className="px-3 py-1 text-[11px] text-t3">{flagMsg}</p> : null}
                <button
                  disabled={flagBusy}
                  onClick={() => void flag("COMPLAINT")}
                  className="w-full text-left px-3 py-1.5 text-sm text-t1 hover:bg-panel-2 disabled:opacity-50"
                >
                  標記投訴
                </button>
                <button
                  disabled={flagBusy}
                  onClick={() => void flag("AI_ERROR")}
                  className="w-full text-left px-3 py-1.5 text-sm text-t1 hover:bg-panel-2 disabled:opacity-50"
                >
                  標記 AI 錯誤
                </button>
              </div>
            </>
          ) : null}
        </div>
        {/* cwi-multiclinic-20260903（MD A.6.1）：〔放手〕— 現任負責人 ∨ ADMIN 見；兩段確認防誤觸 */}
        {canRelease && (
          <button
            data-e2e="release-btn"
            onClick={() => {
              setReleaseError(null);
              if (!releaseArmed) {
                setReleaseArmed(true);
                return;
              }
              setReleaseArmed(false);
              void (async () => {
                const r = await p.onRelease!();
                if (!r.ok) setReleaseError(r.error ?? "放手失敗");
              })();
            }}
            title="放手：取消自己負責人 — 呢條線放返隊列（其他人可以接手）"
            className={`px-2.5 py-1 rounded-full text-[11px] border ${
              releaseArmed
                ? "border-warn-text text-warn-text bg-warn-soft"
                : "border-line text-t2 hover:text-t1 hover:bg-black/[.04]"
            } disabled:opacity-50 whitespace-nowrap`}
            disabled={p.releaseBusy}
          >
            {p.releaseBusy ? "放手緊…" : releaseArmed ? "再撳一次放手？" : "放手"}
          </button>
        )}
        {releaseError && <span className="text-[10px] text-warn-text whitespace-nowrap">{releaseError}</span>}
        <span
          className={`ml-auto text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap inline-flex items-center gap-1 ${windowChipCls}`}
          title="24 小時客服窗口倒數｜窗口內：用 API（呢度覆）｜過窗三出路：① 開手機 App 免費覆（W-5：只覆主動搵過我哋嘅人、唔好複製同一段派多人、叫停即停）② 發 template（逐條收費）③ 等病人下次搵你"
        >
          <Clock size={13} strokeWidth={2.75} />
          {c.window.open ? `窗口 ${windowCountdown(c.window.remainingMs)}` : "已過窗 · 只可發 template"}
        </span>
      </div>

      {/* messages */}
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          if (el.scrollTop < 40 && p.hasMore && !p.loadingOlder) p.onScrollTop();
        }}
        className="flex-1 overflow-y-auto min-h-0 px-4 py-4 md:px-6 space-y-3"
      >
        {p.loadingOlder && <div className="text-center text-[11px] text-t3">載入舊訊息…</div>}
        {visible.length === 0 && !p.loadingOlder && (
          <div className="text-center text-t3 text-sm py-8">（呢個對話仲冇訊息）</div>
        )}
        {visible.map((m, i) => {
          const isOut = m.direction === "OUT";
          const isEcho = m.channel === "APP_ECHO";
          const isHistory = m.channel === "HISTORY";
          const isNote = m.channel === "INTERNAL"; // ★ H1：內部備註（黃底🔒，視覺上同病人訊息完全區隔）
          const isFlow = m.type === "interactive";
          const isAuto = isOut && m.aiAutoSent === true;
          const prev = visible[i - 1];
          const media = mediaSrc(m.mediaPath);
          // ★ T2：中間斷層分隔線插喺此 row 之前（見 gapDividerIdx）
          const gapBefore = gapDividerIdx === i;
          // ★ H1：INTERNAL note — 黃底 + 🔒 + 發送者名（staff 對 staff；病人睇唔到）
          if (isNote) {
            // ★ H2：tick 語義（似 WhatsApp）— 藍 ✓✓ = 全部被 mention staff 已讀；無 mention → 現任 assignee 已讀
            const tick = noteTickState(m, c.assigneeId, p.readReceipts);
            const gotIds = new Set(tick.readBy.map((r) => r.staffId));
            const readList = tick.readBy
              .map((r) => `${staffNameById.get(r.staffId) ?? "Staff"} · ${relTime(r.readAt)}`)
              .join("、");
            const pendingList = tick.requiredStaff
              .filter((s) => !gotIds.has(s))
              .map((s) => staffNameById.get(s) ?? "Staff")
              .join("、");
            const tickTitle = tick.allRead
              ? `已讀：${readList || "—"}`
              : pendingList
                ? `等待已讀：${pendingList}${readList ? `（已讀：${readList}）` : ""}`
                : "等待已讀…";
            return (
              <Fragment key={m.id}>
                {gapBefore && (
                  <div key={`${m.id}::hole-divider`} role="separator" className="text-center text-[11px] text-t3 py-1">
                    ⋯ 中間有訊息未載入，向上捲查看 ⋯
                  </div>
                )}
                <div id={`msg-${m.id}`} data-note-id={m.id} className="flex justify-end">
                <div className="max-w-[70%] px-3.5 py-2.5 rounded-[20px] border border-warn bg-danger-soft text-t1">
                  <div className="text-[10.5px] font-semibold text-warn-text mb-1 inline-flex items-center gap-1">
                    🔒 內部備註 · 唔會發去 WhatsApp
                  </div>
                  {m.body && <div className="break-words text-[13px] leading-[1.6]">{renderNoteBody(m.body, p.staff)}</div>}
                  <div className="flex items-center gap-1 mt-1.5 justify-end">
                    {m.sentByStaffId && (
                      <span className="text-[10px] text-t2">{staffNameById.get(m.sentByStaffId) ?? "Staff"} · </span>
                    )}
                    <span className="text-[10px] text-t3">{bubbleTime(m.waTimestamp, prev?.waTimestamp)}</span>
                    {/* ★ H2：已讀 tick — 灰 ✓ = 已發出；綠 ✓✓ = 全部目標已讀（hover 彈已讀名單） */}
                    <span title={tickTitle} className="inline-flex align-middle">
                      {tick.allRead ? (
                        <CheckCheck size={13} strokeWidth={2.75} className="text-brand-hover" />
                      ) : (
                        <Check size={13} strokeWidth={2.75} className="text-t3" />
                      )}
                    </span>
                  </div>
                </div>
                </div>
              </Fragment>
            );
          }
          return (
            <Fragment key={m.id}>
              {gapBefore && (
                <div key={`${m.id}::hole-divider`} role="separator" className="text-center text-[11px] text-t3 py-1">
                  ⋯ 中間有訊息未載入，向上捲查看 ⋯
                </div>
              )}
            <div id={`msg-${m.id}`} className={`group flex ${isOut ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[70%] px-3.5 py-2.5 text-[13.5px] leading-[1.6] ${
                  isOut
                    ? "bg-bubble-out text-ok-text rounded-[22px] rounded-br-[6px]"
                    : "bg-bubble-in text-t1 shadow-sm rounded-[22px] rounded-bl-[6px]"
                } ${isFlow ? "border border-brand/40" : ""} ${isHistory ? "opacity-60" : ""}`}
              >
                {isAuto && (
                  <div className="text-[10.5px] text-ok-text font-semibold mb-1 inline-flex items-center gap-1">
                    <Sparkles size={11} strokeWidth={2.75} /> 自動覆（系統）
                  </div>
                )}
                {isEcho && (
                  // ★ W-S4-5 (A2)：APP_ECHO 氣泡標「📱 手機 App」（店員手機 App 覆）
                  <div className="text-[10px] text-ok-text font-medium mb-0.5">📱 手機 App</div>
                )}
                {isHistory && <div className="text-[10px] text-t3 mb-0.5">歷史訊息</div>}
                {isFlow ? (
                  <div className="text-[13.5px] inline-flex items-center gap-1.5">
                    <CalendarDays size={14} strokeWidth={2.75} className="text-brand-text shrink-0" />
                    {isOut ? "預約連結（WhatsApp Flow）已發" : "病人完成預約 Flow（nfm_reply）"}
                  </div>
                ) : m.type === "text" && m.body ? (
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {media ? (
                      m.type === "image" ? (
                        <img src={media} alt="" className="rounded-xl max-h-64 max-w-full" />
                      ) : m.type === "audio" ? (
                        <audio controls src={media} className="max-w-full" />
                      ) : (
                        <a
                          href={media}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand-text underline text-xs inline-flex items-center gap-1"
                        >
                          <Paperclip size={11} strokeWidth={2.75} /> 檔案（{m.type}）
                        </a>
                      )
                    ) : (
                      <span className="text-xs text-t3 inline-flex items-center gap-1">
                        <Paperclip size={11} strokeWidth={2.75} /> {m.type}（媒體未落地）
                      </span>
                    )}
                    {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
                  </div>
                )}
                <div className={`flex items-center gap-1 mt-1 ${isOut ? "justify-end" : ""}`}>
                  <span className="text-[10px] text-t3">
                    {isAuto ? `AI 自動發出 · ${bubbleTime(m.waTimestamp, prev?.waTimestamp)}` : bubbleTime(m.waTimestamp, prev?.waTimestamp)}
                  </span>
                  {isOut && m.channel === "API" && <Ticks status={m.status} errorCode={m.errorCode} />}
                  {/* ★ cwi-inboxfix-20260905（MD §5.2/§5.3）：自己發嘅 OUT 文字 — 8 秒撤回倒數 / 過窗 ⋯ 掣 */}
                  {isOut && m.channel === "API" && m.type === "text" && m.sentByStaffId === p.myStaffId && (
                    <UndoControls
                      m={m}
                      onVoid={p.onVoidMessage}
                      onInsertCorrection={(body) => {
                        setDraft(body);
                        requestAnimationFrame(() => taRef.current?.focus());
                      }}
                    />
                  )}
                  {/* ★ Part F（F.5）：IN 文字 bubble hover「＋測試集」（deid 預填彈窗） */}
                  {!isOut && m.type === "text" && !!m.body && (
                    <button
                      onClick={() => void openGolden(m.id)}
                      title="加入 GoldenCase 測試集（自動去識別化 + AI 當時判斷預填）"
                      className="text-[10px] text-t3 hover:text-brand-text opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      ＋測試集
                    </button>
                  )}
                </div>
              </div>
            </div>
            </Fragment>
          );
        })}
      </div>

      {/* composer 區 */}
      <div className="shrink-0 bg-panel border-t border-line p-3">
        {/* Phase 3：預約卡 / 發 Flow 提示 — ★ booking-ui（D）：兩態卡（PENDING 綠邊 / CONFIRMED 撤銷倒數）
            providerslot-20260830 T3：hold 卡（HELD/COMMITTED）— 有 hold 就睇 hold 卡（狀態機後繼態） */}
        {c.holdEvent ? (
          <HoldCard hold={c.holdEvent} locked={locked} onActionDone={() => p.onBookingActionDone?.()} />
        ) : c.pendingBooking ? (
          <BookingCard
            conversation={c}
            booking={c.pendingBooking}
            myStaffId={p.myStaffId}
            onActionDone={() => p.onBookingActionDone?.()}
            slotClaimEnabled={p.slotClaimEnabled}
          />
        ) : (
          c.intent === "BOOKING_REQUEST" &&
          c.window.open &&
          p.slotClaimEnabled !== false && (
            <div className="mb-2 rounded-2xl border border-brand/30 bg-brand-soft p-2 flex items-center gap-2">
              <span className="text-xs text-brand-text">
                病人想預約 — 發預約 Flow 俾病人揀醫生/日期/時間：
              </span>
              <button
                onClick={() => {
                  const pb = c.pendingBooking;
                  requireOutConfirm(
                    `預約 Flow（WhatsApp 預約卡）${pb ? ` · ${pb.requestedDate} ${pb.requestedTime} ${pb.providerName}` : ""}`,
                    () => void sendFlow()
                  );
                }}
                disabled={p.flowBusy || locked}
                title={locked ? "Send Lock：只有負責人可以發 Flow" : undefined}
                className="ml-auto shrink-0 text-xs px-2.5 py-1 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium disabled:opacity-40 inline-flex items-center gap-1"
              >
                <CalendarDays size={12} strokeWidth={2.75} />
                {p.flowBusy ? "發送中…" : "發預約 Flow"}
              </button>
            </div>
          )
        )}
        {flowError && <div className="text-xs text-danger-text mb-1.5">{flowError}</div>}

        {/* ★ cwi-followup-v3（MD §2.2）：跟進建議卡 — AI 草稿卡上面、同款 zone。
            系統只指出邊個對話要跟＋點解；發唔發 = 員工撳。
            窗口內 = 「採用並編輯」填 composer（free-form 可改）→ 發送帶 followupTaskId（sentVia=AI_ADOPTED 無 cooldown）；
            過窗 = 只可發 template（預覽已填變數）；template 未審批 = 等審批 + 唔俾發；
            跳過 = SKIPPED(MANUAL) + dedupWindowDays(7) 內唔再出。 */}
        {p.suggestion &&
          // ★ cwi-final S2-2（N-8）：病人 opt-out → 唔顯示建議卡（server 已即時取消 SUGGESTED；
          //   呢度 = UI 雙保險 — 事件/刷新 race 間隙卡唔會閃現）
          p.suggestion.optOut !== true &&
          (() => {
            const s = p.suggestion;
            const inWindow = !!p.window?.open;
            const winH = p.window ? Math.max(0, Math.ceil((p.window.remainingMs ?? 0) / 3600000)) : 0;
            const noTpl = !s.templateName || s.templatePreview == null;
            // ★ cwi-final S2-5：本地 approved **或** Meta 未批都係「等審批」（engine 雙 gate 同一口徑）
            const unapproved = !noTpl && (s.templateApproved === false || s.templateMetaApproved === false);
            const reason = followupReasonLine(s);
            return (
              <div className="mb-2 rounded-[26px] border-2 border-dashed border-brand/60 bg-panel p-3.5" data-e2e="fu-sugg-card">
                <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                  <Bell size={15} strokeWidth={2.75} className="text-brand-text" />
                  <span className="text-[12.5px] font-semibold text-brand-text">
                    跟進建議 · {s.trigger ? FOLLOWUP_TRIGGER_LABEL[s.trigger] ?? s.trigger : "跟進"}
                  </span>
                  {s.ruleName && <span className="text-[10px] text-t3">（{s.ruleName}）</span>}
                  <span className="ml-auto flex gap-1.5 max-md:w-full max-md:order-last max-md:mt-2 max-md:[&>button]:flex-1">
                    {inWindow && (
                      <button
                        onClick={() => {
                          if (s.templatePreview == null) return;
                          setDraft(s.templatePreview);
                          adoptedFollowupRef.current = s.id; // ★ free-form 採用 = adopted + followupTaskId
                          adoptedDraftRef.current = null;
                        }}
                        disabled={p.suggestionBusy || locked || readOnly || s.templatePreview == null}
                        title={readOnly ? "主管唯讀" : locked ? "先接手（become 負責人）先可以發 WhatsApp" : s.templatePreview == null ? "未設 template — 窗口內可以自己打字" : undefined}
                        className="text-xs px-3 py-1 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium disabled:opacity-40"
                        data-e2e="fu-sugg-adopt"
                      >
                        採用並編輯
                      </button>
                    )}
                    {!inWindow && (
                      <button
                        onClick={() => void suggestionSend()}
                        disabled={p.suggestionBusy || locked || readOnly || noTpl || unapproved}
                        title={readOnly ? "主管唯讀" : locked ? "先接手（become 負責人）先可以發 WhatsApp" : unapproved ? "等 template 審批中" : noTpl ? "未設 template" : undefined}
                        className="text-xs px-3 py-1 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium disabled:opacity-40"
                        data-e2e="fu-sugg-send-template"
                      >
                        發送 template
                      </button>
                    )}
                    <button
                      onClick={() => void suggestionSkip()}
                      disabled={p.suggestionBusy || readOnly}
                      title={readOnly ? "主管唯讀" : undefined}
                      className="text-xs px-3 py-1 rounded-full border border-line-strong text-t2 hover:bg-panel-2 disabled:opacity-40"
                      data-e2e="fu-sugg-skip"
                    >
                      跳過（7 日唔再出）
                    </button>
                  </span>
                </div>
                <div className="text-[11px] mb-1.5" data-e2e="fu-sugg-window">
                  {inWindow ? (
                    <span className="text-t2">窗口 {winH}h · free-form 發得</span>
                  ) : noTpl ? (
                    <span className="text-warn-text">已過窗 · 未設 template（系統發唔出；複製去手機 App 覆）</span>
                  ) : unapproved ? (
                    <span className="text-warn-text">已過窗 · 等 template 審批中（唔俾發）</span>
                  ) : (
                    <span className="text-t2">已過窗 · 只可發 template</span>
                  )}
                  {/* ★ cwi-final S2-5：MARKETING category = 收費較高 — 發前先講清楚 */}
                  {s.templateWaCategory === "MARKETING" && (
                    <span className="text-warn-text"> · 行銷類 template（收費較高）</span>
                  )}
                  {reason && <span className="text-t3"> · {reason}</span>}
                </div>
                {s.templatePreview != null && (
                  <div className="text-[13px] leading-[1.65] text-t1 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                    {s.templatePreview}
                  </div>
                )}
                {locked && (
                  <div className="text-[10px] text-warn-text mt-1">🔒 先〔接手〕成為負責人，先可以採用/發送去 WhatsApp</div>
                )}
              </div>
            );
          })()}

        {/* Phase 2：AI 草稿卡 — signature element：全頁唯一 2px brand 邊框（Organic rounded-[26px]）
            cwi-window-20260901（P2）：COPY_ONLY（過窗）= banner + 複製掣 + 採用並發送 disable
            ★ cwi-final S1-13（D-6）：堆疊 — 1/3 計數 + ‹› 切換 + stale 灰字 + 改字切換確認 */}
        {shownDraft && (
          <div className={`mb-2 rounded-[26px] border-2 bg-panel p-3.5 ${isCopyOnly ? "border-warn" : "border-brand"} ${shownDraft.stale ? "opacity-60" : ""}`} data-testid="c5-draft-card">
            <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
              <Sparkles size={15} strokeWidth={2.75} className={isCopyOnly ? "text-warn-text" : "text-brand-text"} />
              <span className={`text-[12.5px] font-semibold ${isCopyOnly ? "text-warn-text" : "text-brand-text"}`}>
                AI 草稿{isCopyOnly ? "（只可複製）" : ""} · {(shownDraft.latencyMs / 1000).toFixed(1)}s
              </span>
              {/* ★ cwi-inboxfix-20260905（MD §2）：model 名移入 ⓘ tooltip；AI trace 同係呢粒 ⓘ 撳先展開（內容唔變） */}
              <button
                onClick={() => shownDraft?.traceJson && setTraceOpen((v) => !v)}
                title={shownDraft.model}
                aria-label="AI model 同 trace"
                className={isCopyOnly ? "text-warn-text/70 hover:text-warn-text" : "text-t3 hover:text-t1"}
              >
                <Info size={12} strokeWidth={2.25} />
              </button>
              {/* ★ cwi-final S1-13（D-6）：堆疊切換（≥2 個先出） */}
              {p.pendingDrafts.length > 1 && (
                <span className="ml-auto flex items-center gap-1 text-xs text-t3" data-testid="draft-stack-nav">
                  <button
                    aria-label="較新草稿"
                    disabled={p.draftIndex === 0}
                    onClick={() => switchDraft(p.draftIndex - 1)}
                    className="px-1.5 py-0.5 rounded hover:bg-panel-2 hover:text-t1 disabled:opacity-30"
                  >
                    ‹
                  </button>
                  <span data-testid="draft-stack-counter">{p.draftIndex + 1}/{p.pendingDrafts.length}</span>
                  <button
                    aria-label="較舊草稿"
                    disabled={p.draftIndex >= p.pendingDrafts.length - 1}
                    onClick={() => switchDraft(p.draftIndex + 1)}
                    className="px-1.5 py-0.5 rounded hover:bg-panel-2 hover:text-t1 disabled:opacity-30"
                  >
                    ›
                  </button>
                </span>
              )}
              <span className="ml-auto flex gap-1.5 max-md:w-full max-md:order-last max-md:mt-2 max-md:[&>button]:flex-1">
                {!isCopyOnly && (
                  <button
                    onClick={() => {
                      setDraft(shownDraft!.draftText);
                      filledTextRef.current = shownDraft!.draftText; // ★ cwi-final S1-13：填入基準（改字判定）
                      adoptedDraftRef.current = shownDraft!.id; // ★ C5 §8.4：採用並編輯（含後續改動）= adopted
                      void p.onAdopt(shownDraft!.id);
                    }}
                    disabled={p.draftBusy || locked}
                    title={locked ? "先接手（become 負責人）先可以採用草稿發 WhatsApp" : undefined}
                    className="text-xs px-3 py-1 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium disabled:opacity-40"
                  >
                    採用並編輯
                  </button>
                )}
                {isCopyOnly && (
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(shownDraft!.draftText).then(() => {
                        setCopiedDraft(true);
                        setTimeout(() => setCopiedDraft(false), 2000);
                      }).catch(() => undefined);
                    }}
                    className="text-xs px-3 py-1 rounded-full bg-warn hover:opacity-90 text-warn-text font-medium"
                  >
                    {copiedDraft ? "✓ 已複製" : "複製去手機 App"}
                  </button>
                )}
                <button
                  onClick={() => void p.onDiscard(shownDraft!.id)}
                  disabled={p.draftBusy}
                  className="text-xs px-3 py-1 rounded-full border border-line-strong text-t2 hover:bg-panel-2 disabled:opacity-40"
                >
                  棄用
                </button>
              </span>
            </div>
            {/* ★ cwi-final S1-13（D-6）：stale = 呢個草稿之後病人再講咗嘢（非回覆最新嗰句） */}
            {shownDraft.stale && (
              <div className="text-[11px] text-t3 mb-1.5" data-testid="draft-stale">
                病人之後再講咗嘢
              </div>
            )}
            {/* ★ cwi-final S1-13（D-6）：卡係舊個（index > 0）→ 有新草稿提示 */}
            {p.draftIndex > 0 && (
              <div className="text-[11px] text-brand-text mb-1.5" data-testid="draft-newer-hint">
                有新草稿 ↑
              </div>
            )}
            {isCopyOnly && (
              <div className="text-[11px] text-warn-text bg-warn-soft rounded-xl px-2.5 py-1.5 mb-1.5">
                24 小時窗口已過 — 呢段字發唔出。複製去手機 WhatsApp App 覆（免費、echo 自動回流）
              </div>
            )}
            {locked && !isCopyOnly && (
              <div className="text-[10px] text-warn-text mb-1">🔒 先〔接手〕成為負責人，先可以採用草稿發去 WhatsApp</div>
            )}
            <div className="text-[13px] leading-[1.65] text-t1 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {shownDraft.draftText}
            </div>
            {/* ★ Part F（cwi-raggolden-20260904，F.7）：trace panel — ★ cwi-inboxfix-20260905（MD §2）：收埋做 ⓘ 掣展開（內容唔變） */}
            {shownDraft.traceJson && traceOpen && (
              <div className="mt-1.5 rounded-xl border border-line bg-panel-2/60">
                <TracePanel trace={shownDraft.traceJson} />
              </div>
            )}
          </div>
        )}
        {sendError && <div className="text-xs text-danger-text mb-1.5">{sendError}</div>}
        {templateOptions && templateOptions.length > 0 && (
          /* Phase B：過窗 template 覆 — server 422 帶回 APPROVED+UTILITY 名單；撳掣帶 templateName 發 */
          <div className="rounded-2xl border border-warn bg-warn-soft p-2.5 mb-1.5">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-medium text-warn-text">24h 窗口已過 — 揀一個 template 發：</span>
              <button
                onClick={() => setTemplateOptions(null)}
                className="ml-auto text-[10px] text-t3 hover:text-t1"
              >
                取消
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {templateOptions.map((t) => (
                <button
                  key={t.name}
                  onClick={() => requireOutConfirm(`Template：${t.name}`, () => void sendTemplate(t.name))}
                  disabled={templateBusy}
                  className="text-xs px-3 py-1.5 rounded-full bg-panel border border-line-strong text-t1 hover:bg-panel-2 disabled:opacity-40"
                >
                  {t.name} <span className="text-[10px] text-t3">{t.language}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {locked ? (
          /* ★ H1 Send Lock：amber 內部備註 composer — 發 WhatsApp 已停用，只可發 staff↔staff 備註
             ★ H2：打 @ 彈同店 staff 自動補全（選中 → mentions；發去後端校驗） */
          <div className="rounded-2xl border border-warn bg-warn-soft p-2.5">
            {/* ★ cwi-inboxfix-20260905（MD §3 I-7）：兩行結構 — 接手掣（行 1 右）同發送掣（行 2）垂直相距 ≥16px；
                行 2 發送掣 absolute -top-2（8px 凸出）→ 行距要 ≥ 16+8 → mb-7（28px）= 實測 edge gap 20px */}
            <div className="flex items-center gap-2 mb-7">
              <span className="text-xs font-medium text-warn-text inline-flex items-center gap-1">
                <Lock size={12} strokeWidth={2.75} />
                此對話由 {assigneeName ?? "其他同事"} 負責 — 你只可發內部備註
              </span>
              {!readOnly && (
                <button
                  onClick={() => void p.onTakeover()}
                  disabled={p.takeoverBusy}
                  className="ml-auto shrink-0 text-xs px-3 py-1 rounded-full bg-warn text-warn-text font-semibold hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1"
                >
                  <StickyNote size={12} strokeWidth={2.75} />
                  {p.takeoverBusy ? "接手咗…" : "接手"}
                </button>
              )}
            </div>
            <div className="relative">
              {/* ★ H2：@ 自動補全 dropdown（同店 active staff；↑↓ 揀 / Enter 選 / Esc 收） */}
              {mentionState && mentionCandidates.length > 0 && (
                <div className="absolute bottom-full left-0 mb-1 w-64 max-h-56 overflow-y-auto rounded-2xl border border-line bg-panel shadow-lg z-20 py-1">
                  <div className="px-3 py-1 text-[10px] text-t3 inline-flex items-center gap-1">
                    <Users size={10} strokeWidth={2.75} /> @ 通知同事（同店）
                  </div>
                  {mentionCandidates.map((s, i) => (
                    <button
                      key={s.id}
                      onMouseDown={(e) => {
                        e.preventDefault(); // 唔好 blur textarea
                        applyMention(s.name);
                      }}
                      onMouseEnter={() => setMentionIdx(i)}
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${
                        i === mentionIdx ? "bg-brand-soft text-brand-text" : "text-t1 hover:bg-panel-2"
                      }`}
                    >
                      <span className="w-5 h-5 rounded-full bg-panel-2 text-t2 flex items-center justify-center text-[10px] font-medium shrink-0">
                        {s.name.charAt(0)}
                      </span>
                      <span className="truncate">{s.name}</span>
                      {s.role === "ADMIN" && <span className="ml-auto text-[10px] text-t3">ADMIN</span>}
                      {s.role === "SUPERVISOR" && <span className="ml-auto text-[10px] text-t3">主管</span>}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setMentionState(detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length));
                  setMentionIdx(0);
                }}
                onKeyDown={(e) => {
                  // ★ H2：dropdown 開住時 — 方向鍵/Enter/Tab 揀 candidate，唔係發送
                  if (mentionState && mentionCandidates.length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setMentionIdx((v) => (v + 1) % mentionCandidates.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionIdx((v) => (v - 1 + mentionCandidates.length) % mentionCandidates.length);
                      return;
                    }
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      applyMention(mentionCandidates[mentionIdx].name);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setMentionState(null);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    setMentionState(null);
                    void sendNote();
                  }
                }}
                rows={1}
                placeholder="寫內部備註…"
                className="w-full resize-none rounded-full bg-panel border border-warn px-4 py-2 text-sm text-t1 placeholder:text-t3 focus:outline-none focus:border-warn"
              />
              <button
                onClick={() => void sendNote()}
                disabled={sendingNote || !draft.trim()}
                aria-label="發送內部備註"
                className="absolute -top-2 -right-2 w-9 h-9 shrink-0 rounded-full bg-warn hover:opacity-90 text-warn-text flex items-center justify-center disabled:opacity-40"
              >
                <Send size={15} strokeWidth={2.75} />
              </button>
            </div>
          </div>
        ) : c.window.open ? (
          readOnly ? (
            /* ★ cwi-routing-20260906 §8：SUPERVISOR 全店唯讀 — 無覆客 composer（API 層 403 雙保險） */
            <div className="rounded-2xl border border-line bg-panel-2 px-4 py-2.5 text-xs text-t3">
              主管（唯讀）— 可以睇對話、發內部備註，但唔可以覆病人（由當值同事 / 負責人處理）
            </div>
          ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => {
                  const v = e.target.value;
                  // ★ C5 §8.4：清空 / 手改 composer = 唔再係原稿採用 → 採用旗清（之後發送 = typed）
                  // ★ cwi-final S0-4（N-10.1）：清空（含空白）= 採用關係斷 — draft + followup 旗都清（T607）
                  if (v.trim() === "") {
                    adoptedDraftRef.current = null;
                    adoptedFollowupRef.current = null;
                  }
                  setDraft(v);
                }}
                onKeyDown={(e) => {
                  // ★ cwi-final S1-13（D-6）：Alt+↑／Alt+↓ = 堆疊切換（↑ 較新 / ↓ 較舊）
                  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                    e.preventDefault();
                    switchDraft(p.draftIndex + (e.key === "ArrowDown" ? 1 : -1));
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="輸入訊息…（Enter 發送，Shift+Enter 換行）"
                data-testid="c5-composer"
                className="flex-1 resize-none rounded-full bg-panel-2 border border-transparent px-4 py-2 text-sm text-t1 placeholder:text-t3 focus:outline-none focus:border-brand focus:bg-panel"
              />
              <button
                onClick={() => void send()}
                disabled={sending || !draft.trim()}
                aria-label="發送"
                data-testid="c5-send-btn"
                className="w-10 h-10 max-md:w-12 max-md:h-12 shrink-0 rounded-full bg-brand hover:bg-brand-hover text-panel flex items-center justify-center disabled:opacity-40"
              >
                <Send size={15} strokeWidth={2.75} />
              </button>
            </div>
          </div>
          )
        ) : (
          /* cwi-window-20260901（P3 / W-1）：過窗三出路 — 共享組件（D.3 排班板/迷你表同源複用；markup 同原版本一致） */
          <WindowExits
            conversation={c}
            myStaffId={p.myStaffId}
            draftText={shownDraft?.draftText}
            onError={(m) => setSendError(m)}
          />
        )}
      </div>
      {/* ★ Part F（cwi-raggolden-20260904，F.5）：加入測試集彈窗（預填去識別化 utterance + AI 當時判斷） */}
      {goldenMsgId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-panel rounded-lg w-full max-w-md max-h-[85vh] overflow-auto p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">加入 GoldenCase 測試集</h2>
              <button onClick={() => setGoldenMsgId(null)} className="text-t2 hover:text-t1">✕</button>
            </div>
            <p className="text-xs text-t2">
              文字已自動去識別化（電話→&lt;phone&gt;、姓名→&lt;name&gt;；日期/金額保留）。預填咗 AI 當時判斷，請確認正確 intent。
            </p>
            {goldenErr && <div className="bg-danger-soft text-danger text-xs rounded px-2 py-1.5">{goldenErr}</div>}
            {!goldenPrefill && !goldenErr && <div className="text-xs text-t2">載入預填中…</div>}
            {goldenPrefill && goldenForm && (
              <>
                {goldenPrefill.contextBefore.length > 0 && (
                  <div className="text-xs text-t2 bg-panel-2 rounded px-2 py-1.5">前情（去識別化）：{goldenPrefill.contextBefore.join(" ／ ")}</div>
                )}
                <label className="block text-xs text-t2">
                  病人句（可改 — 必須保持去識別化）
                  <textarea
                    value={goldenForm.utterance}
                    onChange={(e) => setGoldenForm({ ...goldenForm, utterance: e.target.value })}
                    rows={3}
                    className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                  />
                </label>
                <label className="block text-xs text-t2">
                  正確 intent（AI 當時：{goldenPrefill.aiJudgment.intent}{goldenPrefill.hasDraft ? "" : " — 冇 draft，用對話 intent"}）
                  <select
                    value={goldenForm.expectIntent}
                    onChange={(e) => setGoldenForm({ ...goldenForm, expectIntent: e.target.value })}
                    className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                  >
                    {["BOOKING_REQUEST", "QUESTION", "URGENT_PAIN", "COMPLAINT", "OUT_OF_SCOPE", "OTHER"].map((i) => (
                      <option key={i} value={i}>{i}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={goldenForm.expectRedFlag}
                    onChange={(e) => setGoldenForm({ ...goldenForm, expectRedFlag: e.target.checked })}
                  />
                  應該紅旗（高危/急症）
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={goldenForm.expectAutoOk}
                    onChange={(e) => setGoldenForm({ ...goldenForm, expectAutoOk: e.target.checked })}
                  />
                  應該可自動覆（唔需要人手）
                </label>
                <label className="block text-xs text-t2">
                  期望知識引用 doc id（逗號分隔；可留空）
                  <input
                    value={goldenForm.expectDocIds}
                    onChange={(e) => setGoldenForm({ ...goldenForm, expectDocIds: e.target.value })}
                    className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                  />
                </label>
                <label className="block text-xs text-t2">
                  備註
                  <input
                    value={goldenForm.note}
                    onChange={(e) => setGoldenForm({ ...goldenForm, note: e.target.value })}
                    className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                  />
                </label>
                <div className="flex justify-end gap-2 pt-1">
                  <button onClick={() => setGoldenMsgId(null)} className="text-sm border rounded px-3 py-1.5 hover:bg-canvas">
                    取消
                  </button>
                  <button
                    onClick={() => void submitGolden()}
                    disabled={goldenBusy || !goldenForm.utterance.trim()}
                    className="text-sm bg-brand text-panel rounded px-3 py-1.5 font-medium disabled:opacity-50"
                  >
                    {goldenBusy ? "儲存中…" : "存入測試集"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* ★ cwi-inboxfix-20260905（MD §5.1）：外發確認（Flow/template）— 病人名 + 內容 + 取消/確認 */}
      {outConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setOutConfirm(null)}
        >
          <div className="bg-panel rounded-2xl shadow-xl p-4 w-[340px] border border-line" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-2">確認發送？</div>
            <div className="text-xs text-t2 mb-1">
              將發俾：<span className="text-t1 font-medium">{outConfirm.to}</span>
            </div>
            <div className="text-xs text-t2 mb-3">內容：{outConfirm.desc}</div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOutConfirm(null)}
                className="text-xs px-3 py-1.5 rounded-full border border-line hover:bg-line/30"
              >
                取消
              </button>
              <button
                onClick={runOutConfirm}
                className="text-xs px-3 py-1.5 rounded-full bg-brand text-panel font-medium hover:bg-brand-hover"
              >
                確認發送
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="sr-only">{relTime(c.lastMessageAt)}</div>
    </section>
  );
}
