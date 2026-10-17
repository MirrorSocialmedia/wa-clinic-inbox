"use client";

import { useRef, useState } from "react";
import { Users } from "lucide-react";
import type { StaffInfo } from "./types";

// ── ★ H2：@mention helper（純函數 — autocomplete 偵測 + 內文反推 mentions + 高亮渲染） ──
// ★ cwi-inbox-r3 Q3：由 chat-pane 搬嚟 — 內部備註只喺右邊備註欄寫（detail-pane NoteComposer）。

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
  return s.replace(/[.*+?^${}()|\]\\]/g, "\\$&");
}

/** note 內文渲染：@Name 高亮（MD §5：note 內文渲染 @B 高亮） */
export function renderNoteBody(body: string, staff: StaffInfo[]) {
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

/**
 * ★ cwi-inbox-r3 Q3：備註欄輸入框（打 @ 彈同店 staff 自動補全；↑↓ 揀 / Enter 選 / Esc 收；Enter 發送）。
 * mentions 由內文 @Name 反推（server 端再校驗同店 active）。
 */
export function NoteComposer({
  staff,
  busy,
  onSend,
}: {
  staff: StaffInfo[];
  busy: boolean;
  onSend: (body: string, mentions: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [mention, setMention] = useState<{ query: string; atPos: number } | null>(null);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const candidates =
    mention === null
      ? []
      : staff
          .filter((s) => s.name && s.name.toLowerCase().startsWith(mention.query.toLowerCase()))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 8);

  function apply(name: string) {
    const el = inputRef.current;
    if (!mention || !el) return;
    const caret = el.selectionStart ?? draft.length;
    const before = draft.slice(0, mention.atPos);
    const next = `${before}@${name} ${draft.slice(caret)}`;
    setDraft(next);
    setMention(null);
    const pos = before.length + name.length + 2;
    requestAnimationFrame(() => el.setSelectionRange(pos, pos));
  }

  async function send() {
    const body = draft.trim();
    if (!body || busy) return;
    setMention(null);
    if (await onSend(body, mentionsFromBody(body, staff))) setDraft("");
  }

  return (
    <div className="relative mt-2 flex items-center gap-1.5">
      {mention && candidates.length > 0 && (
        <div className="absolute bottom-full left-0 mb-1 w-56 max-h-52 overflow-y-auto rounded-2xl border border-line bg-panel shadow-lg z-20 py-1">
          <div className="px-3 py-1 text-[10px] text-t3 inline-flex items-center gap-1">
            <Users size={10} strokeWidth={2.75} /> @ 通知同事
          </div>
          {candidates.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault(); // 唔好 blur input
                apply(s.name);
              }}
              onMouseEnter={() => setIdx(i)}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                i === idx ? "bg-brand-soft text-brand-text" : "text-t1 hover:bg-panel-2"
              }`}
            >
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setMention(detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length));
          setIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME 組字中唔當發送
          if (mention && candidates.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((v) => (v + 1) % candidates.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((v) => (v - 1 + candidates.length) % candidates.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              apply(candidates[idx].name);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          if (e.key === "Enter") {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="加備註…（@ 同事）"
        aria-label="新增內部備註"
        className="flex-1 min-w-0 text-xs rounded-full bg-panel border border-line px-3 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-danger"
      />
      <button
        type="button"
        onClick={() => void send()}
        disabled={busy || !draft.trim()}
        className="shrink-0 text-xs px-2.5 py-1.5 rounded-full bg-danger text-white font-medium hover:opacity-90 disabled:opacity-50"
      >
        加
      </button>
    </div>
  );
}
