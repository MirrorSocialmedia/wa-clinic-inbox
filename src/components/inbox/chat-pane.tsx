"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationItem, MessageItem } from "./types";
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
 */
export function ChatPane(p: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);

  // 新訊息時自動捲底（只係貼住底先自動捲，用戶向上看舊嘢時唔跳）
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [p.messages]);

  useEffect(() => {
    setDraft("");
    setSendError(null);
    pinnedRef.current = true;
  }, [p.conversation?.id]);

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
          const prev = p.messages[i - 1];
          const media = mediaSrc(m.mediaPath);
          return (
            <div key={m.id} className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[70%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                  isOut
                    ? isEcho
                      ? "bg-teal-100 text-neutral-800"
                      : "bg-emerald-100 text-neutral-800"
                    : "bg-white text-neutral-800 border border-neutral-200"
                } ${isHistory ? "opacity-70" : ""}`}
              >
                {isEcho && (
                  <div className="text-[10px] text-teal-700 font-medium mb-0.5">📱 App 發出</div>
                )}
                {isHistory && (
                  <div className="text-[10px] text-neutral-400 mb-0.5">歷史訊息</div>
                )}
                {m.type === "text" && m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
                {m.type !== "text" && (
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
