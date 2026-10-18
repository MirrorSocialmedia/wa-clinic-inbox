"use client";

/**
 * ★ cwi-mobile-ux-20261018（擁有人拍板）：composer 😊 emoji 面板 — 內置常用 emoji（唔裝第三方套件）。
 *
 * - 手機（variant="sheet"）：面板頂替鍵盤位置（composer 下面一格），撳 emoji 插入游標位，面板唔收；
 * - 桌面（variant="popover"）：📎 📅 😊 上面彈細框，撳外面收。
 * - 「常用」= 最近用過排先（localStorage — 純個人便利；讀唔到就用預設）。
 * 內部備註欄唔加（擁有人拍板）。
 */
import { useEffect, useState } from "react";

const CATEGORIES: { key: string; label: string; emojis: string[] }[] = [
  {
    key: "face",
    label: "表情",
    emojis: ["😀", "😃", "😄", "😁", "😊", "🙂", "😉", "😍", "🥰", "😘", "🤗", "🤔", "😅", "😂", "🤣", "😌", "😮", "😯", "😢", "😭", "😷", "🤒", "🤕", "😴", "😬", "🙏", "😇", "🥲", "😎", "🤩"],
  },
  {
    key: "hand",
    label: "手勢",
    emojis: ["👍", "👌", "🙏", "👏", "🙌", "👋", "🤝", "💪", "✌️", "🤞", "👉", "👆", "👇", "☝️", "✋", "🫶"],
  },
  {
    key: "symbol",
    label: "符號",
    emojis: ["❤️", "💕", "✅", "☑️", "❌", "⚠️", "❗", "❓", "⭐", "🌟", "✨", "🎉", "🎊", "🔔", "💬", "📌", "📍", "⏰", "⌛", "🆗", "🆕", "➡️", "⬅️", "🔁"],
  },
  {
    key: "clinic",
    label: "診所",
    emojis: ["🦷", "🪥", "🏥", "👩‍⚕️", "👨‍⚕️", "💊", "🩺", "🩹", "🌡️", "📅", "🗓️", "📞", "📱", "💳", "🧾", "🚇", "🚌", "🚗", "🌞", "🌙", "☔", "🎂", "🍬", "🥤"],
  },
];

const DEFAULT_RECENT = ["🙂", "👍", "🙏", "😊", "❤️", "✅", "📅", "⏰", "🦷", "👌", "😀", "🎉"];
const RECENT_KEY = "wa-inbox:emoji-recent";
const RECENT_MAX = 24;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(arr) && arr.every((x) => typeof x === "string") && arr.length ? (arr as string[]) : DEFAULT_RECENT;
  } catch {
    return DEFAULT_RECENT;
  }
}

function pushRecent(e: string): string[] {
  const next = [e, ...readRecent().filter((x) => x !== e)].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 私密模式等 — 唔記都照用 */
  }
  return next;
}

export function EmojiPicker({
  variant,
  onPick,
  onClose,
}: {
  variant: "sheet" | "popover";
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("recent");
  const [recent, setRecent] = useState<string[]>(DEFAULT_RECENT);
  useEffect(() => setRecent(readRecent()), []);

  const list = tab === "recent" ? recent : (CATEGORIES.find((c) => c.key === tab)?.emojis ?? []);
  const tabs = [{ key: "recent", label: "常用" }, ...CATEGORIES.map((c) => ({ key: c.key, label: c.label }))];

  const panel = (
    <div
      className={
        variant === "sheet"
          ? "rounded-2xl border border-line bg-panel px-2 pt-1.5 pb-2"
          : "absolute bottom-full left-0 mb-2 z-30 w-[320px] rounded-2xl border border-line bg-panel shadow-lg px-2 pt-1.5 pb-2"
      }
      data-e2e="emoji-picker"
      role="dialog"
      aria-label="插入 emoji"
    >
      <div className="flex gap-1 mb-1.5 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] ${tab === t.key ? "bg-brand-soft text-brand-text font-medium" : "text-t2 hover:bg-panel-2"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={`grid grid-cols-8 gap-0.5 overflow-y-auto ${variant === "sheet" ? "max-h-[176px]" : "max-h-[200px]"}`}>
        {list.map((e) => (
          <button
            key={e}
            type="button"
            // 唔搶 textarea focus（桌面保持游標；手機唔彈返鍵盤）
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => {
              onPick(e);
              setRecent(pushRecent(e));
            }}
            className="h-9 rounded-lg text-[22px] leading-none hover:bg-panel-2 active:bg-panel-2"
            aria-label={e}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );

  if (variant === "sheet") return panel;
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden="true" />
      {panel}
    </>
  );
}
