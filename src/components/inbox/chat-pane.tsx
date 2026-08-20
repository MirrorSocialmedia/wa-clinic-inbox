"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCheck,
  Clock,
  Lock,
  MessageCircle,
  Paperclip,
  Send,
  Sparkles,
  StickyNote,
} from "lucide-react";
import type { ConversationItem, DraftInfo, MessageItem, StaffInfo } from "./types";
import { bubbleTime, relTime, windowCountdown } from "./time";

interface Props {
  conversation: ConversationItem | null;
  messages: MessageItem[];
  hasMore: boolean;
  loadingOlder: boolean;
  onScrollTop: () => void;
  window: { open: boolean; remainingMs: number; tone: string } | null;
  onSend: (body: string) => Promise<{ ok: boolean; error?: string }>;
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
  /** ★ H1：自己嘅 staffId（Send Lock 三狀態判定：自己負責/別人負責/unassigned） */
  myStaffId: string;
  /** ★ H1：發內部備註（lock 模式 composer 用；INTERNAL — 唔出 WhatsApp） */
  onSendNote: (body: string) => Promise<{ ok: boolean; error?: string }>;
  /** ★ H1：〔接手〕— POST assign {toStaffId: self}（lock 翻轉） */
  onTakeover: () => Promise<{ ok: boolean; error?: string }>;
  /** ★ H1：接手進行中（disable 掣） */
  takeoverBusy: boolean;
  /** ★ H1：店內 staff 列表（INTERNAL note 顯示發送者名） */
  staff: StaffInfo[];
}

/** status tick（OUT API 訊息）— lucide 版 */
function Ticks({ status, errorCode }: { status: string; errorCode: string | null }) {
  if (status === "FAILED") {
    return (
      <span
        title={`發送失敗${errorCode ? `：${errorCode}` : ""}`}
        className="text-danger-text text-[11px] font-semibold inline-flex items-center gap-0.5"
      >
        <AlertTriangle size={11} /> {errorCode}
      </span>
    );
  }
  if (status === "READ") return <CheckCheck size={13} className="text-brand" />;
  if (status === "DELIVERED") return <CheckCheck size={13} className="text-t3" />;
  if (status === "SENT") return <Check size={13} className="text-t3" />;
  if (status === "QUEUED") return <span className="text-t3 text-[11px]">…</span>;
  return null;
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
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  const autoFilledDraftRef = useRef<string | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [p.messages]);

  useEffect(() => {
    setDraft("");
    setSendError(null);
    pinnedRef.current = true;
    autoFilledDraftRef.current = null;
  }, [p.conversation?.id]);

  useEffect(() => {
    if (!p.pendingDraft) {
      autoFilledDraftRef.current = null;
      return;
    }
    if (autoFilledDraftRef.current === p.pendingDraft.id) return;
    // ★ H1：lock 模式（assignee 係其他人）唔好 auto-fill AI 草稿入 composer — 嗰度係內部備註欄
    const locked = !!p.conversation?.assigneeId && p.conversation?.assigneeId !== p.myStaffId;
    if (locked) return;
    if (draft.trim() === "") {
      setDraft(p.pendingDraft.draftText);
      autoFilledDraftRef.current = p.pendingDraft.id;
    }
  }, [p.pendingDraft, draft, p.conversation?.assigneeId, p.myStaffId]);

  if (!p.conversation) {
    return (
      <section className="flex-1 min-w-0 flex items-center justify-center bg-canvas">
        <div className="text-center text-t3 text-sm flex flex-col items-center gap-2">
          <MessageCircle size={36} strokeWidth={1.25} />
          <div>揀一個對話開始</div>
        </div>
      </section>
    );
  }

  const c = p.conversation;
  // ★ H1 Send Lock 三狀態：locked = 有負責人且唔係自己（composer 轉內部備註模式）
  const locked = !!c.assigneeId && c.assigneeId !== p.myStaffId;
  const assigneeName = c.assigneeName ?? null;
  const staffNameById = new Map(p.staff.map((s) => [s.id, s.name]));
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
    setSendingNote(true);
    setSendError(null);
    const r = await p.onSendNote(body);
    if (!r.ok) setSendError(r.error ?? "內部備註發送失敗");
    else setDraft("");
    setSendingNote(false);
  }

  async function send() {
    const body = draft.trim();
    if (!body || sending || !c) return;
    setSending(true);
    setSendError(null);
    const r = await p.onSend(body);
    if (!r.ok) setSendError(r.error ?? "發送失敗");
    else setDraft("");
    setSending(false);
  }

  return (
    <section className="flex-1 min-w-0 flex flex-col min-h-0 bg-canvas">
      {/* header：avatar + contact + 窗口 chip */}
      <div className="h-[52px] shrink-0 bg-panel border-b border-line flex items-center gap-2.5 px-4">
        <div className="w-8 h-8 rounded-full bg-brand-soft text-brand-text flex items-center justify-center text-[13px] font-medium shrink-0">
          {initialOf(c)}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-t1 truncate">
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
        <span
          className={`ml-auto text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap inline-flex items-center gap-1 ${windowChipCls}`}
          title="24 小時客服窗口倒數"
        >
          <Clock size={11} />
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
        className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-1.5"
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
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[70%] px-3 py-2 rounded-xl border border-warn/50 bg-warn-soft text-t1">
                  <div className="text-[10px] font-medium text-warn-text mb-0.5 inline-flex items-center gap-1">
                    🔒 內部備註 · 唔會發去 WhatsApp
                  </div>
                  {m.body && <div className="whitespace-pre-wrap break-words text-sm">{m.body}</div>}
                  <div className="flex items-center gap-1 mt-1 justify-end">
                    {m.sentByStaffId && (
                      <span className="text-[10px] text-t2">{staffNameById.get(m.sentByStaffId) ?? "Staff"} · </span>
                    )}
                    <span className="text-[10px] text-t3">{bubbleTime(m.waTimestamp, prev?.waTimestamp)}</span>
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[70%] px-3 py-2 text-sm ${
                  isOut
                    ? "bg-bubble-out text-t1 rounded-xl rounded-br-[4px]"
                    : "bg-bubble-in text-t1 border border-line rounded-xl rounded-bl-[4px]"
                } ${isFlow ? "border border-brand/40" : ""} ${isHistory ? "opacity-60" : ""}`}
              >
                {isAuto && (
                  <div className="text-[10px] text-brand-text font-medium mb-0.5 inline-flex items-center gap-1">
                    <Sparkles size={10} /> 自動覆（系統）
                  </div>
                )}
                {isEcho && (
                  <div className="text-[10px] text-ok-text font-medium mb-0.5">📱 App 發出</div>
                )}
                {isHistory && <div className="text-[10px] text-t3 mb-0.5">歷史訊息</div>}
                {isFlow ? (
                  <div className="text-sm inline-flex items-center gap-1.5">
                    <CalendarDays size={14} className="text-brand-text shrink-0" />
                    {isOut ? "預約連結（WhatsApp Flow）已發" : "病人完成預約 Flow（nfm_reply）"}
                  </div>
                ) : m.type === "text" && m.body ? (
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {media ? (
                      m.type === "image" ? (
                        <img src={media} alt="" className="rounded-lg max-h-64 max-w-full" />
                      ) : m.type === "audio" ? (
                        <audio controls src={media} className="max-w-full" />
                      ) : (
                        <a
                          href={media}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand-text underline text-xs inline-flex items-center gap-1"
                        >
                          <Paperclip size={11} /> 檔案（{m.type}）
                        </a>
                      )
                    ) : (
                      <span className="text-xs text-t3 inline-flex items-center gap-1">
                        <Paperclip size={11} /> {m.type}（媒體未落地）
                      </span>
                    )}
                    {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
                  </div>
                )}
                <div className={`flex items-center gap-1 mt-1 ${isOut ? "justify-end" : ""}`}>
                  <span className="text-[10px] text-t3">
                    {bubbleTime(m.waTimestamp, prev?.waTimestamp)}
                  </span>
                  {isOut && m.channel === "API" && <Ticks status={m.status} errorCode={m.errorCode} />}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* composer 區 */}
      <div className="shrink-0 bg-panel border-t border-line p-3">
        {/* Phase 3：預約卡 / 發 Flow 提示 */}
        {c.pendingBooking ? (
          <div className="mb-2 rounded-xl border border-ok/40 bg-ok-soft p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-ok-text inline-flex items-center gap-1">
                <CalendarDays size={13} /> 新預約請求
              </span>
              <span className="text-sm text-t1 font-medium truncate">
                {c.pendingBooking.providerName} · {c.pendingBooking.requestedDate}{" "}
                {c.pendingBooking.requestedTime}
              </span>
              <a
                href="/bookings"
                className="ml-auto shrink-0 text-xs px-2.5 py-1 rounded-lg bg-ok text-white font-medium hover:opacity-90"
              >
                去 /bookings 處理 →
              </a>
            </div>
          </div>
        ) : (
          c.intent === "BOOKING_REQUEST" &&
          c.window.open && (
            <div className="mb-2 rounded-xl border border-brand/30 bg-brand-soft p-2 flex items-center gap-2">
              <span className="text-xs text-brand-text">
                病人想預約 — 發預約 Flow 俾病人揀醫生/日期/時間：
              </span>
              <button
                onClick={() => void sendFlow()}
                disabled={p.flowBusy || locked}
                title={locked ? "Send Lock：只有負責人可以發 Flow" : undefined}
                className="ml-auto shrink-0 text-xs px-2.5 py-1 rounded-lg bg-brand hover:bg-brand-hover text-white font-medium disabled:opacity-40 inline-flex items-center gap-1"
              >
                <CalendarDays size={12} />
                {p.flowBusy ? "發送中…" : "發預約 Flow"}
              </button>
            </div>
          )
        )}
        {flowError && <div className="text-xs text-danger-text mb-1.5">{flowError}</div>}

        {/* Phase 2：AI 草稿卡 — signature element：全頁唯一 2px brand 邊框 */}
        {p.pendingDraft && (
          <div className="mb-2 rounded-xl border-2 border-brand/50 bg-panel p-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Sparkles size={14} className="text-brand-text" />
              <span className="text-xs font-semibold text-brand-text">AI 草稿</span>
              <span className="text-[10px] text-t3">本地模型 · 你確認先發出</span>
              <span className="ml-auto flex gap-1.5">
                <button
                  onClick={() => {
                    setDraft(p.pendingDraft!.draftText);
                    void p.onAdopt(p.pendingDraft!.id);
                  }}
                  disabled={p.draftBusy || locked}
                  title={locked ? "先接手（become 負責人）先可以採用草稿發 WhatsApp" : undefined}
                  className="text-xs px-3 py-1 rounded-lg bg-brand hover:bg-brand-hover text-white font-medium disabled:opacity-40"
                >
                  採用並編輯
                </button>
                <button
                  onClick={() => void p.onDiscard(p.pendingDraft!.id)}
                  disabled={p.draftBusy}
                  className="text-xs px-3 py-1 rounded-lg border border-line-strong text-t2 hover:bg-panel-2 disabled:opacity-40"
                >
                  棄用
                </button>
              </span>
            </div>
            {locked && (
              <div className="text-[10px] text-warn-text mb-1">🔒 先〔接手〕成為負責人，先可以採用草稿發去 WhatsApp</div>
            )}
            <div className="text-sm text-t1 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {p.pendingDraft.draftText}
            </div>
          </div>
        )}
        {sendError && <div className="text-xs text-danger-text mb-1.5">{sendError}</div>}

        {locked ? (
          /* ★ H1 Send Lock：amber 內部備註 composer — 發 WhatsApp 已停用，只可發 staff↔staff 備註 */
          <div className="rounded-xl border border-warn/60 bg-warn-soft p-2.5">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-medium text-warn-text inline-flex items-center gap-1">
                <Lock size={12} />
                此對話由 {assigneeName ?? "其他同事"} 負責 — 你只可發內部備註
              </span>
              <button
                onClick={() => void p.onTakeover()}
                disabled={p.takeoverBusy}
                className="ml-auto shrink-0 text-xs px-3 py-1 rounded-lg bg-warn text-white font-medium hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1"
              >
                <StickyNote size={12} />
                {p.takeoverBusy ? "接手咗…" : "接手"}
              </button>
            </div>
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendNote();
                  }
                }}
                rows={1}
                placeholder="內部備註（唔會發去 WhatsApp；Enter 發送）…"
                className="flex-1 resize-none rounded-2xl bg-panel border border-warn/50 px-4 py-2 text-sm text-t1 placeholder:text-t3 focus:outline-none focus:border-warn"
              />
              <button
                onClick={() => void sendNote()}
                disabled={sendingNote || !draft.trim()}
                aria-label="發送內部備註"
                className="w-9 h-9 shrink-0 rounded-full bg-warn hover:opacity-90 text-white flex items-center justify-center disabled:opacity-40"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        ) : c.window.open ? (
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
              className="flex-1 resize-none rounded-2xl bg-panel-2 border border-transparent px-4 py-2 text-sm text-t1 placeholder:text-t3 focus:outline-none focus:border-brand focus:bg-panel"
            />
            <button
              onClick={() => void send()}
              disabled={sending || !draft.trim()}
              aria-label="發送"
              className="w-9 h-9 shrink-0 rounded-full bg-brand hover:bg-brand-hover text-white flex items-center justify-center disabled:opacity-40"
            >
              <Send size={15} />
            </button>
          </div>
        ) : (
          <div className="text-sm text-t2 text-center py-2 bg-panel-2 rounded-xl">
            24 小時客服窗口已過 — 只可以發 template（utility），free-form 已停用
          </div>
        )}
      </div>
      <div className="sr-only">{relTime(c.lastMessageAt)}</div>
    </section>
  );
}
