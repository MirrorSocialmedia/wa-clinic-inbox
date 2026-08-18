"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationItem, DraftInfo, MessageItem } from "./types";
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
}

/** status tick（OUT API 訊息） */
function Ticks({ status, errorCode }: { status: string; errorCode: string | null }) {
  if (status === "FAILED") {
    return <span title={`發送失敗${errorCode ? `：${errorCode}` : ""}`} className="text-red-500 text-[11px] font-bold">⚠ {errorCode}</span>;
  }
  if (status === "READ") return <span className="text-sky-500 text-[11px]">✓✓</span>;
  if (status === "DELIVERED") return <span className="text-neutral-400 text-[11px]">✓✓</span>;
  if (status === "SENT") return <span className="text-neutral-400 text-[11px]">✓</span>;
  if (status === "QUEUED") return <span className="text-neutral-300 text-[11px]">…</span>;
  return null;
}

function mediaSrc(mediaPath: string | null): string | null {
  if (!mediaPath) return null;
  // /srv/wa-media/{wamid}.ext → /api/media/{basename}（basename 安全，route 端防 traversal）
  const base = mediaPath.split("/").pop() ?? mediaPath;
  return `/api/media/${encodeURIComponent(base)}`;
}

/**
 * 對話欄（MD §6.4）：
 * - 氣泡：IN 左 / OUT 右；OUT-APP_ECHO 加「📱 App 發出」標記；HISTORY 淺色 +「歷史」
 * - status tick（SENT ✓ / DELIVERED ✓✓ / READ 藍✓✓ / FAILED 紅⚠）
 * - 24h 窗口倒數 chip（綠 <6h、黃、紅 過窗）
 * - 向上捲載入舊訊息（含 HISTORY 段，分頁 50/頁）
 * - Composer：過窗 disabled + 提示
 * - Phase 2：AI draft 卡（對話欄上方）— 採用（入 composer，可改）/ 棄（DELETE）
 *   鐵律 2：採用 ≠ 發送；發送仍係人手（sentByStaffId）
 */
export function ChatPane(p: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  // 已自動填入過嘅 draft id（避免重複覆蓋；staff 改咗 composer 後唔會再被蓋）
  const autoFilledDraftRef = useRef<string | null>(null);

  // 新訊息時自動捲底（只係貼住底先自動捲，用戶向上看舊嘢時唔跳）
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

  // Phase 2：新 draft 到达時，composer 空就先自動填入（staff 開始打字後唔再蓋）
  useEffect(() => {
    if (!p.pendingDraft) {
      autoFilledDraftRef.current = null;
      return;
    }
    if (autoFilledDraftRef.current === p.pendingDraft.id) return;
    if (draft.trim() === "") {
      setDraft(p.pendingDraft.draftText);
      autoFilledDraftRef.current = p.pendingDraft.id;
    }
  }, [p.pendingDraft, draft]);

  if (!p.conversation) {
    return (
      <section className="flex-1 min-w-0 flex items-center justify-center bg-neutral-50">
        <div className="text-center text-neutral-400 text-sm space-y-1">
          <div className="text-4xl">💬</div>
          <div>揀一個對話開始</div>
        </div>
      </section>
    );
  }

  const c = p.conversation;
  const toneCls =
    c.window.tone === "red"
      ? "bg-red-100 text-red-700 border-red-200"
      : c.window.tone === "yellow"
        ? "bg-amber-100 text-amber-700 border-amber-200"
        : "bg-emerald-100 text-emerald-700 border-emerald-200";

  async function sendFlow() {
    if (flowError) setFlowError(null);
    const r = await p.onSendFlow();
    if (!r.ok) setFlowError(r.error ?? "發送失敗");
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
    <section className="flex-1 min-w-0 flex flex-col min-h-0 bg-neutral-50">
      {/* header：contact + 窗口 chip */}
      <div className="h-12 shrink-0 bg-white border-b border-neutral-200 flex items-center gap-2 px-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-neutral-900 truncate">
            {c.contact?.profileName || "未命名聯絡人"}
          </div>
          {c.contact?.waId && <div className="text-[11px] text-neutral-400">{c.contact.waId}</div>}
        </div>
        <span
          className={`ml-auto text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${toneCls}`}
          title="24 小時客服窗口倒數"
        >
          {c.window.open ? `窗口 ${windowCountdown(c.window.remainingMs)}` : "窗口已過，只可發 template"}
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
        className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-1"
      >
        {p.loadingOlder && <div className="text-center text-[11px] text-neutral-400">載入舊訊息…</div>}
        {p.messages.length === 0 && !p.loadingOlder && (
          <div className="text-center text-neutral-400 text-sm py-8">（呢個對話仲冇訊息）</div>
        )}
        {p.messages.map((m, i) => {
          const isOut = m.direction === "OUT";
          const isEcho = m.channel === "APP_ECHO";
          const isHistory = m.channel === "HISTORY";
          const isFlow = m.type === "interactive"; // Phase 3：Flow 訊息（OUT=發 Flow / IN=nfm_reply）
          // Phase 2b：AI 自動發送（AUTO 模式）— 視覺標記俾 staff 審計
          const isAuto = isOut && m.aiAutoSent === true;
          const prev = p.messages[i - 1];
          const media = mediaSrc(m.mediaPath);
          return (
            <div key={m.id} className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[70%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                  isOut
                    ? isEcho
                      ? "bg-teal-100 text-neutral-800"
                      : isFlow
                        ? "bg-violet-100 text-neutral-800 border border-violet-200"
                        : "bg-emerald-100 text-neutral-800"
                    : isFlow
                      ? "bg-violet-50 text-neutral-800 border border-violet-200"
                      : "bg-white text-neutral-800 border border-neutral-200"
                } ${isHistory ? "opacity-70" : ""}`}
              >
                {isAuto && (
                  <div className="text-[10px] text-violet-700 font-medium mb-0.5">🤖 自動覆（系統）</div>
                )}
                {isEcho && (
                  <div className="text-[10px] text-teal-700 font-medium mb-0.5">📱 App 發出</div>
                )}
                {isHistory && (
                  <div className="text-[10px] text-neutral-400 mb-0.5">歷史訊息</div>
                )}
                {isFlow ? (
                  <div className="text-sm">
                    {isOut ? "📅 預約連結（WhatsApp Flow）已發" : "📅 病人完成預約 Flow（nfm_reply）"}
                  </div>
                ) : m.type === "text" && m.body ? (
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {media ? (
                      m.type === "image" ? (
                        <img src={media} alt="" className="rounded max-h-64 max-w-full" />
                      ) : m.type === "audio" ? (
                        <audio controls src={media} className="max-w-full" />
                      ) : (
                        <a href={media} target="_blank" rel="noreferrer" className="text-sky-600 underline text-xs">
                          📎 檔案（{m.type}）
                        </a>
                      )
                    ) : (
                      <span className="text-xs text-neutral-500">📎 {m.type}（媒體未落地）</span>
                    )}
                    {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
                  </div>
                )}
                <div className={`flex items-center gap-1 mt-1 ${isOut ? "justify-end" : ""}`}>
                  <span className="text-[10px] text-neutral-400">{bubbleTime(m.waTimestamp, prev?.waTimestamp)}</span>
                  {isOut && m.channel === "API" && <Ticks status={m.status} errorCode={m.errorCode} />}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* composer */}
      <div className="shrink-0 bg-white border-t border-neutral-200 p-3">
        {/* Phase 3：預約卡 — PENDING = 綠色卡（病人撳咗 Complete）；BOOKING_REQUEST intent = 📅 掣 */}
        {c.pendingBooking ? (
          <div className="mb-2 rounded border border-emerald-300 bg-emerald-50 p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-emerald-800">📅 新預約請求</span>
              <span className="text-sm text-emerald-900 font-medium">
                {c.pendingBooking.providerName} · {c.pendingBooking.requestedDate} {c.pendingBooking.requestedTime}
              </span>
              <a
                href="/bookings"
                className="ml-auto text-xs px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
              >
                去 /bookings 處理 →
              </a>
            </div>
          </div>
        ) : (
          c.intent === "BOOKING_REQUEST" &&
          c.window.open && (
            <div className="mb-2 rounded border border-violet-200 bg-violet-50 p-2 flex items-center gap-2">
              <span className="text-xs text-violet-800">🗓️ 病人想預約 — 發預約 Flow 俾病人揀醫生/日期/時間：</span>
              <button
                onClick={() => void sendFlow()}
                disabled={p.flowBusy}
                className="ml-auto text-xs px-2.5 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white font-medium disabled:opacity-40"
              >
                {p.flowBusy ? "發送中…" : "📅 預約"}
              </button>
            </div>
          )
        )}
        {flowError && <div className="text-xs text-red-600 mb-1.5">{flowError}</div>}
        {/* Phase 2：pending AI draft 卡 — 只係建議，staff 一鍵採用先入 composer */}
        {p.pendingDraft && (
          <div className="mb-2 rounded border border-sky-200 bg-sky-50 p-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-sky-800">🤖 AI 建議覆</span>
              <span className="text-[10px] text-sky-600">只係建議 — 未發送，需你確認</span>
              <span className="ml-auto flex gap-1.5">
                <button
                  onClick={() => {
                    setDraft(p.pendingDraft!.draftText);
                    void p.onAdopt(p.pendingDraft!.id);
                  }}
                  disabled={p.draftBusy}
                  className="text-xs px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-700 text-white font-medium disabled:opacity-40"
                >
                  採用
                </button>
                <button
                  onClick={() => void p.onDiscard(p.pendingDraft!.id)}
                  disabled={p.draftBusy}
                  className="text-xs px-2.5 py-1 rounded border border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50 disabled:opacity-40"
                >
                  棄
                </button>
              </span>
            </div>
            <div className="text-sm text-neutral-700 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {p.pendingDraft.draftText}
            </div>
          </div>
        )}
        {sendError && <div className="text-xs text-red-600 mb-1.5">{sendError}</div>}
        {c.window.open ? (
          <div className="flex gap-2">
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
              className="flex-1 resize-none rounded border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            <button
              onClick={() => void send()}
              disabled={sending || !draft.trim()}
              className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-40"
            >
              {sending ? "…" : "發送"}
            </button>
          </div>
        ) : (
          <div className="text-sm text-neutral-500 text-center py-2 bg-neutral-50 rounded">
            24 小時客服窗口已過 — 只可以發 template（utility），free-form 已停用
          </div>
        )}
      </div>
      <div className="sr-only">{relTime(c.lastMessageAt)}</div>
    </section>
  );
}
