"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCheck,
  Clock,
  ChevronLeft,
  Lock,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Send,
  Sparkles,
  StickyNote,
  Users,
} from "lucide-react";
import type { ConversationItem, DraftInfo, DraftTrace, MessageItem, NoteReceipt, StaffInfo } from "./types";
import { noteTickState } from "./types";
import { bubbleTime, relTime, windowCountdown } from "./time";
import { BookingCard } from "./booking-card";
import { HoldCard } from "./hold-card";
import { WindowExits } from "./window-exits";

interface Props {
  conversation: ConversationItem | null;
  /** 手機返回列表（md 以下顯示 back 掣） */
  onBack: () => void;
  /** 手機撳 header 開詳情 sheet */
  onOpenDetail: () => void;
  messages: MessageItem[];
  hasMore: boolean;
  loadingOlder: boolean;
  onScrollTop: () => void;
  window: { open: boolean; remainingMs: number; tone: string } | null;
  onSend: (body: string) => Promise<{ ok: boolean; error?: string; templates?: { name: string; language: string }[]; /** cwi-multiclinic-20260903：423 打字保護 — 帶新負責人 id（draft 保留由 composer 行為保證） */ takenOverBy?: string | null }>;
  staffName: string;
  /** Phase 2：該對話最新嘅 pending AI 草稿（PROPOSED）；null = 無 */
  pendingDraft: DraftInfo | null;
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
  /** Phase B：過窗 template 發送（422 後 composer 出揀選 → 撳掣帶 templateName 發）；唔傳 = 功能唔啟用 */
  onSendTemplate?: (name: string) => Promise<{ ok: boolean; error?: string }>;
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
  userRole: "ADMIN" | "STAFF";
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

/**
 * 對話欄（MD §6.4）v2 — WhatsApp 式氣泡 + brand AI 草稿卡。
 * 邏輯同 v1 完全一樣（auto-fill draft / scroll pin / 分頁 / flow / booking）。
 */
export function ChatPane(p: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendingNote, setSendingNote] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  // Phase B：過窗 422 後嘅 template 揀選（server 回嘅 APPROVED+UTILITY 名單）
  const [templateOptions, setTemplateOptions] = useState<{ name: string; language: string }[] | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  // cwi-window-20260901（P2）：COPY_ONLY 草稿「複製」掣 feedback（「已複製」2s）
  const [copiedDraft, setCopiedDraft] = useState(false);
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
  // Organic：draft 已填入 composer 時頂部 brand-soft 提示條（純視覺；清空重寫 / 草稿消失就收）
  const [fillHint, setFillHint] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  const autoFilledDraftRef = useRef<string | null>(null);
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

  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [p.messages]);

  useEffect(() => {
    setDraft("");
    setSendError(null);
    setMentionState(null);
    setMentionIdx(0);
    setTemplateOptions(null);
    setFillHint(false);
    pinnedRef.current = true;
    autoFilledDraftRef.current = null;
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
  }, [p.messages, p.conversation?.id]);

  useEffect(() => {
    if (!p.pendingDraft) {
      autoFilledDraftRef.current = null;
      setFillHint(false);
      setCopiedDraft(false);
      return;
    }
    if (autoFilledDraftRef.current !== p.pendingDraft.id) setCopiedDraft(false);
    if (autoFilledDraftRef.current === p.pendingDraft.id) return;
    // cwi-window-20260901（P2）：COPY_ONLY 過窗草稿唔入 composer（發唔出 — 只准複製去手機 App）
    if (p.pendingDraft.mode === "COPY_ONLY") return;
    // ★ H1：lock 模式（assignee 係其他人）唔好 auto-fill AI 草稿入 composer — 嗰度係內部備註欄
    const locked = !!p.conversation?.assigneeId && p.conversation?.assigneeId !== p.myStaffId;
    if (locked) return;
    if (draft.trim() === "") {
      setDraft(p.pendingDraft.draftText);
      autoFilledDraftRef.current = p.pendingDraft.id;
      setFillHint(true);
    }
  }, [p.pendingDraft, draft, p.conversation?.assigneeId, p.myStaffId]);

  if (!p.conversation) {
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
  // cwi-window-20260901（P2）：COPY_ONLY 過窗草稿（發唔出 — 只准複製去手機 App）
  const isCopyOnly = p.pendingDraft?.mode === "COPY_ONLY";
  const assigneeName = c.assigneeName ?? null;
  const staffNameById = new Map(p.staff.map((s) => [s.id, s.name]));
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
    const r = await p.onSend(body);
    if (!r.ok) {
      // cwi-multiclinic-20260903（MD A.6.2）：423 打字保護 — 文字保留（setDraft 唔郁）；
      // toast「{name} 已接手呢個對話」由 parent（inbox-client）發出；header 負責人名 optimistic 更新。
      setSendError(r.takenOverBy ? "對話已被接手 — 你而家只可發內部備註" : r.error ?? "發送失敗");
      // Phase B：過窗 422 帶 templates 名單 → 出 template 揀選
      if (r.templates && r.templates.length > 0) setTemplateOptions(r.templates);
    } else setDraft("");
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
            {assigneeName && (
              <div className={`text-[10px] inline-flex items-center gap-0.5 ${locked ? "text-warn-text" : "text-t3"}`}>
                <Lock size={9} />
                負責人：{c.assigneeId === p.myStaffId ? "你" : assigneeName}
              </div>
            )}
          </div>
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
        {p.messages.length === 0 && !p.loadingOlder && (
          <div className="text-center text-t3 text-sm py-8">（呢個對話仲冇訊息）</div>
        )}
        {p.messages.map((m, i) => {
          const isOut = m.direction === "OUT";
          const isEcho = m.channel === "APP_ECHO";
          const isHistory = m.channel === "HISTORY";
          const isNote = m.channel === "INTERNAL"; // ★ H1：內部備註（黃底🔒，視覺上同病人訊息完全區隔）
          const isFlow = m.type === "interactive";
          const isAuto = isOut && m.aiAutoSent === true;
          const prev = p.messages[i - 1];
          const media = mediaSrc(m.mediaPath);
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
              <div key={m.id} id={`msg-${m.id}`} data-note-id={m.id} className="flex justify-end">
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
            );
          }
          return (
            <div key={m.id} id={`msg-${m.id}`} className={`group flex ${isOut ? "justify-end" : "justify-start"}`}>
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
                  <div className="text-[10px] text-ok-text font-medium mb-0.5">📱 App 發出</div>
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
          />
        ) : (
          c.intent === "BOOKING_REQUEST" &&
          c.window.open && (
            <div className="mb-2 rounded-2xl border border-brand/30 bg-brand-soft p-2 flex items-center gap-2">
              <span className="text-xs text-brand-text">
                病人想預約 — 發預約 Flow 俾病人揀醫生/日期/時間：
              </span>
              <button
                onClick={() => void sendFlow()}
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

        {/* Phase 2：AI 草稿卡 — signature element：全頁唯一 2px brand 邊框（Organic rounded-[26px]）
            cwi-window-20260901（P2）：COPY_ONLY（過窗）= banner + 複製掣 + 採用並發送 disable */}
        {p.pendingDraft && (
          <div className={`mb-2 rounded-[26px] border-2 bg-panel p-3.5 ${isCopyOnly ? "border-warn" : "border-brand"}`}>
            <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
              <Sparkles size={15} strokeWidth={2.75} className={isCopyOnly ? "text-warn-text" : "text-brand-text"} />
              <span className={`text-[12.5px] font-semibold ${isCopyOnly ? "text-warn-text" : "text-brand-text"}`}>
                AI 草稿{isCopyOnly ? "（只可複製）" : ""}
              </span>
              <span className="text-[10.5px] text-t2">
                {p.pendingDraft.model} · {(p.pendingDraft.latencyMs / 1000).toFixed(1)}s · {isCopyOnly ? "過窗發唔出 — 複製去手機 App" : "你確認先發出"}
              </span>
              <span className="ml-auto flex gap-1.5 max-md:w-full max-md:order-last max-md:mt-2 max-md:[&>button]:flex-1">
                {!isCopyOnly && (
                  <button
                    onClick={() => {
                      setDraft(p.pendingDraft!.draftText);
                      setFillHint(true);
                      void p.onAdopt(p.pendingDraft!.id);
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
                      void navigator.clipboard.writeText(p.pendingDraft!.draftText).then(() => {
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
                  onClick={() => void p.onDiscard(p.pendingDraft!.id)}
                  disabled={p.draftBusy}
                  className="text-xs px-3 py-1 rounded-full border border-line-strong text-t2 hover:bg-panel-2 disabled:opacity-40"
                >
                  棄用
                </button>
              </span>
            </div>
            {isCopyOnly && (
              <div className="text-[11px] text-warn-text bg-warn-soft rounded-xl px-2.5 py-1.5 mb-1.5">
                24 小時窗口已過 — 呢段字發唔出。複製去手機 WhatsApp App 覆（免費、echo 自動回流）
              </div>
            )}
            {locked && !isCopyOnly && (
              <div className="text-[10px] text-warn-text mb-1">🔒 先〔接手〕成為負責人，先可以採用草稿發去 WhatsApp</div>
            )}
            <div className="text-[13px] leading-[1.65] text-t1 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {p.pendingDraft.draftText}
            </div>
            {/* ★ Part F（cwi-raggolden-20260904，F.7）：trace panel — 可展開段（workflow/gates/lexicon/檢索/price/latency） */}
            {p.pendingDraft.traceJson && (
              <details className="mt-1.5 rounded-xl border border-line bg-panel-2/60">
                <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[10.5px] text-t2 hover:text-t1">
                  ⚙ AI trace（workflow / 閘 / 檢索引用 / price-guard）
                </summary>
                <TracePanel trace={p.pendingDraft.traceJson} />
              </details>
            )}
            <div className="text-[10.5px] text-t2 mt-1.5">
              {isCopyOnly
                ? "COPY_ONLY：唔計入採用率統計（發唔出唔係模型質素問題）· 複製去手機 App 覆（免費）"
                : "採用＝記帳（採用率計 SENT_AS_IS／SENT_EDITED）· 棄用＝DISCARDED · 兩者都入週報"}
            </div>
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
                  onClick={() => void sendTemplate(t.name)}
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
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-medium text-warn-text inline-flex items-center gap-1">
                <Lock size={12} strokeWidth={2.75} />
                此對話由 {assigneeName ?? "其他同事"} 負責 — 你只可發內部備註
              </span>
              <button
                onClick={() => void p.onTakeover()}
                disabled={p.takeoverBusy}
                className="ml-auto shrink-0 text-xs px-3 py-1 rounded-full bg-warn text-warn-text font-semibold hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1"
              >
                <StickyNote size={12} strokeWidth={2.75} />
                {p.takeoverBusy ? "接手咗…" : "接手"}
              </button>
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
                placeholder="內部備註（唔會發去 WhatsApp；打 @ 通知同事；Enter 發送）…"
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
          <div className="flex flex-col gap-1.5">
            {/* Organic：draft 已填入 composer 提示條（清空重寫 = 清空 composer） */}
            {p.pendingDraft && fillHint && (
              <div className="flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1.5">
                <Check size={12} strokeWidth={2.75} className="text-brand-text shrink-0" />
                <span className="text-[11.5px] font-semibold text-brand-text">草稿已填入 composer — 可直接改</span>
                <button
                  onClick={() => {
                    setDraft("");
                    setFillHint(false);
                  }}
                  className="ml-auto text-[11px] font-semibold text-brand-text/75 hover:text-brand-text"
                >
                  清空重寫
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="輸入訊息…（Enter 發送，Shift+Enter 換行）"
                className="flex-1 resize-none rounded-full bg-panel-2 border border-transparent px-4 py-2 text-sm text-t1 placeholder:text-t3 focus:outline-none focus:border-brand focus:bg-panel"
              />
              <button
                onClick={() => void send()}
                disabled={sending || !draft.trim()}
                aria-label="發送"
                className="w-10 h-10 max-md:w-12 max-md:h-12 shrink-0 rounded-full bg-brand hover:bg-brand-hover text-panel flex items-center justify-center disabled:opacity-40"
              >
                <Send size={15} strokeWidth={2.75} />
              </button>
            </div>
          </div>
        ) : (
          /* cwi-window-20260901（P3 / W-1）：過窗三出路 — 共享組件（D.3 排班板/迷你表同源複用；markup 同原版本一致） */
          <WindowExits
            conversation={c}
            myStaffId={p.myStaffId}
            draftText={p.pendingDraft?.draftText}
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
      <div className="sr-only">{relTime(c.lastMessageAt)}</div>
    </section>
  );
}
