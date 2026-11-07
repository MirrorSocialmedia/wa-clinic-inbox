"use client";

/**
 * ★ cwi-search-20261107：對話內搜尋列（對話頂部 🔍 打開）。
 * - 打字（停 400ms）或 Enter → GET /api/conversations/[id]/search；預設跳去最新一個命中
 * - ▲ 舊啲／▼ 新啲（Enter = 下一個舊嘅；Shift+Enter = 新啲）；Esc 收埋
 * - 「包埋內部備註」：內部備註喺右邊備註欄 → 跳轉交返 parent（開備註欄 + 閃）
 * - 命中字喺泡泡入面用黃色標（HighlightText — parent 傳 q 落 MessageBubble）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

export interface ConvSearchHit {
  id: string;
  createdAt: string;
  channel: string;
  direction: string;
  snippet: string | null;
}

export function ConversationSearchBar({
  conversationId,
  onJump,
  onQueryChange,
  onClose,
}: {
  conversationId: string;
  /** 跳去某條命中（parent 負責補載 + 捲 + 閃）；回 false = 跳唔到 */
  onJump: (hit: ConvSearchHit) => Promise<boolean>;
  /** 而家用緊嘅搜尋字（俾泡泡標黃） */
  onQueryChange: (q: string | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [internal, setInternal] = useState(false);
  const [hits, setHits] = useState<ConvSearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [idx, setIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // parent 傳落嚟嘅 callback 每次 render 都係新 identity — 用 ref 固定，否則收件箱一有 realtime 更新就會重新搜尋兼彈返最新命中
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  const onQueryRef = useRef(onQueryChange);
  onQueryRef.current = onQueryChange;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const jumpTo = useCallback(
    async (list: ConvSearchHit[], i: number) => {
      if (i < 0 || i >= list.length) return;
      setIdx(i);
      const ok = await onJumpRef.current(list[i]);
      if (!ok) setErr("跳唔到嗰條訊息（可能太舊或者已刪）");
      else setErr(null);
    },
    [],
  );

  const run = useCallback(
    async (text: string, withInternal: boolean) => {
      const t = text.trim();
      const seq = ++reqSeq.current;
      if (!t) {
        setHits(null);
        setTotal(0);
        setIdx(-1);
        setErr(null);
        onQueryRef.current(null);
        return;
      }
      setBusy(true);
      try {
        const r = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/search?q=${encodeURIComponent(t)}${withInternal ? "&internal=1" : ""}`);
        const d = (await r.json().catch(() => null)) as { hits?: ConvSearchHit[]; total?: number; message?: string } | null;
        if (seq !== reqSeq.current) return; // 打字期間有新搜尋 → 舊結果棄
        if (!r.ok) {
          setErr(d?.message ?? "搜尋失敗");
          setHits([]);
          setTotal(0);
          return;
        }
        const list = d?.hits ?? [];
        setHits(list);
        setTotal(d?.total ?? list.length);
        setErr(null);
        onQueryRef.current(t);
        if (list.length) void jumpTo(list, list.length - 1);
        else setIdx(-1);
      } catch {
        if (seq === reqSeq.current) setErr("網絡錯誤");
      } finally {
        if (seq === reqSeq.current) setBusy(false);
      }
    },
    [conversationId, jumpTo],
  );

  // 打字停 400ms 自動搜
  useEffect(() => {
    const t = window.setTimeout(() => void run(q, internal), 400);
    return () => window.clearTimeout(t);
  }, [q, internal, run]);

  const n = hits?.length ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-[12.5px]" data-e2e="conv-search">
      <Search size={14} strokeWidth={2.75} className="shrink-0 text-t3" aria-hidden />
      <input
        ref={inputRef}
        value={q}
        maxLength={100}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && !e.nativeEvent.isComposing && hits && n) {
            e.preventDefault();
            void jumpTo(hits, e.shiftKey ? Math.min(n - 1, idx + 1) : Math.max(0, idx - 1));
          }
        }}
        placeholder="搵呢個對話入面嘅字…"
        className="min-w-0 flex-1 bg-transparent text-sm text-t1 placeholder:text-t3 focus:outline-none"
        data-e2e="conv-search-input"
      />
      <span className="shrink-0 text-[11.5px] text-t3" data-e2e="conv-search-count">
        {busy ? "搵緊…" : hits === null ? "" : n === 0 ? "搵唔到" : `第 ${n - idx}／${total > n ? `${n}+` : n} 個`}
      </span>
      <button
        type="button"
        disabled={!hits || idx <= 0}
        onClick={() => hits && void jumpTo(hits, idx - 1)}
        className="rounded-full p-1 text-t2 hover:bg-panel-2 disabled:opacity-30"
        aria-label="上一個（舊啲）"
        data-e2e="conv-search-older"
      >
        <ChevronUp size={16} strokeWidth={2.75} />
      </button>
      <button
        type="button"
        disabled={!hits || idx < 0 || idx >= n - 1}
        onClick={() => hits && void jumpTo(hits, idx + 1)}
        className="rounded-full p-1 text-t2 hover:bg-panel-2 disabled:opacity-30"
        aria-label="下一個（新啲）"
        data-e2e="conv-search-newer"
      >
        <ChevronDown size={16} strokeWidth={2.75} />
      </button>
      <button type="button" onClick={onClose} className="rounded-full p-1 text-t2 hover:bg-panel-2" aria-label="關閉搜尋" data-e2e="conv-search-close">
        <X size={15} strokeWidth={2.75} />
      </button>
      <label className="flex w-full items-center gap-1.5 pl-6 text-[11px] text-t3 md:w-auto md:pl-0">
        <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
        包埋內部備註
      </label>
      {err && <div className="w-full pl-6 text-[11px] text-danger-text">{err}</div>}
    </div>
  );
}

/** 命中字標黃（唔分大小寫；q 空 = 原文） */
export function HighlightText({ text, q }: { text: string; q: string | null | undefined }) {
  const needle = (q ?? "").trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: (string | { m: string })[] = [];
  let from = 0;
  for (let i = lower.indexOf(n); i >= 0 && out.length < 400; i = lower.indexOf(n, i + n.length)) {
    if (i > from) out.push(text.slice(from, i));
    out.push({ m: text.slice(i, i + n.length) });
    from = i + n.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return (
    <>
      {out.map((part, i) =>
        typeof part === "string" ? (
          <span key={i}>{part}</span>
        ) : (
          <mark key={i} className="rounded-[3px] bg-yellow-200 px-[1px] text-t1">
            {part.m}
          </mark>
        ),
      )}
    </>
  );
}
