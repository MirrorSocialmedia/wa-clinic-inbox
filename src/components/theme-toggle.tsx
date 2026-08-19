"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

/**
 * 光暗切換掣（nav rail 底部用）。
 * - 讀 <html data-theme>（由 layout inline script 喺 first paint 前設定）
 * - 撳掣：flip data-theme + 寫 localStorage("wcx-theme")
 * - SSR 唔知 theme → mount 前 render 中性 icon 位（避免 hydration mismatch）
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("wcx-theme", next);
    } catch {
      /* private mode 等情況：唔記住，但今次 session 照切 */
    }
    setTheme(next);
  }

  return (
    <button
      onClick={toggle}
      title={theme === "dark" ? "切換亮色" : "切換暗色"}
      aria-label="切換光暗主題"
      className="w-8 h-8 rounded-lg flex items-center justify-center text-t2 hover:bg-panel-2 hover:text-t1"
    >
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
