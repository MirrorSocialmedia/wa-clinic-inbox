"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 成熟度儀表板 + 級別開關 client（Phase E — cwi-ai-20260825-t5）。
 *
 * 矩陣：行 = 店、列 = intent 六類；URGENT_PAIN / COMPLAINT 兩列鎖死「永遠人手」（無掣）。
 * 每格：現級 badge（L1 灰 / L2 藍 / L3 紫 / L4 綠）+ 4 週 adoptRate 迷你走勢 + eligible ✓/reasons hover
 * + 級別下拉（白名單外灰 — 白名單 = env AUTOMATION_ADMIN_STAFF_IDS）。
 * 頂部：全局 kill 狀態（AI_GLOBAL_MAX_LEVEL 現值）+〔全店降 L1〕紅掣（confirm 兩次 → 逐店寫 "*"→L1）。
 *
 * 所有 mutation 經 /api/admin/automation（requireAdmin；PATCH 另有白名單 + 鎖類 400 雙擋）。
 */
interface Cell {
  level: string;
  locked: boolean;
  stats: { weekStart: string; draftCount: number; adoptedAsIs: number; adoptedEdited: number; complaints: number; rollbacks: number }[];
  adoptRateTrend: (number | null)[];
  eligible: boolean;
  reasons: string[];
}
interface ClinicRow {
  id: string;
  code: string;
  name: string;
  cells: Record<string, Cell>;
}
interface Matrix {
  global: { maxLevel: string; whitelistEnabled: boolean; canPatch: boolean };
  weeks: string[];
  categories: string[];
  lockedCategories: string[];
  clinics: ClinicRow[];
}

const LEVEL_STYLE: Record<string, string> = {
  L1: "bg-line text-t2",
  L2: "bg-brand-soft text-brand-text",
  L3: "bg-ok-soft text-ok-text",
  L4: "bg-brand text-panel font-semibold",
};

function Trend({ rates }: { rates: (number | null)[] }) {
  // 4 週迷你走勢：格高 = rate（無數據 = 淡灰格）
  return (
    <span className="inline-flex items-end gap-0.5 h-4" title={rates.map((r) => `${r === null ? "—" : (r * 100).toFixed(0)}%`).join(" / ")}>
      {rates.map((r, i) => (
        <span
          key={i}
          className={`w-1.5 rounded-sm ${r === null ? "bg-line" : r >= 0.9 ? "bg-brand" : r >= 0.7 ? "bg-warn" : "bg-danger"}`}
          style={{ height: r === null ? "20%" : `${Math.max(20, r * 100)}%` }}
        />
      ))}
    </span>
  );
}

function LevelSelect({ clinicId, cat, value, disabled, onDone }: { clinicId: string; cat: string; value: string; disabled: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <select
      value={value}
      disabled={disabled || busy}
      onChange={async (e) => {
        const level = e.target.value;
        if (level === value) return;
        setBusy(true);
        try {
          const res = await fetch("/api/admin/automation", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clinicId, category: cat, level }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            alert(j.message ?? `調級失敗（HTTP ${res.status}）`);
          } else {
            onDone();
          }
        } finally {
          setBusy(false);
        }
      }}
      className={`text-xs rounded-full border border-line bg-panel px-2 py-1 ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      {["L1", "L2", "L3", "L4"].map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}

export default function AutomationAdmin() {
  const [data, setData] = useState<Matrix | null>(null);
  const [error, setError] = useState("");
  const [killBusy, setKillBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/admin/automation")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData((await r.json()) as Matrix);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const killAll = useCallback(async () => {
    if (!data) return;
    if (!window.confirm('全店降 L1（全部店預設級 "*"）？AI 立即退回只出草稿。')) return;
    if (!window.confirm("再次確認：呢個動作會影響所有店嘅自動化行為，要繼續？")) return;
    setKillBusy(true);
    try {
      const results = await Promise.all(
        data.clinics.map((c) =>
          fetch("/api/admin/automation", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clinicId: c.id, category: "*", level: "L1" }),
          }).then(async (r) => ({ code: c.code, ok: r.ok }))
        )
      );
      const bad = results.filter((r) => !r.ok).map((r) => r.code);
      if (bad.length > 0) alert(`部分店失敗：${bad.join(", ")} — 重試`);
      load();
    } finally {
      setKillBusy(false);
    }
  }, [data, load]);

  if (error) return <p className="text-sm text-danger-text">{error}</p>;
  if (!data) return <p className="text-sm text-t3">載入中…</p>;

  return (
    <div className="max-w-6xl mx-auto">
      <h1 className="text-xl font-bold text-t1 mb-1">AI 自動化級別（成熟度儀表板）</h1>
      <p className="text-sm text-t3 mb-4">
        資格 = 連續 4 完整週 adoptRate≥90% 且零投訴/回退且每週樣本≥20。開關全程 audit；
        {data.global.whitelistEnabled ? " 只限白名單管理員調級。" : " 所有 ADMIN 可調級。"}
      </p>

      {/* 全局 kill 狀態 */}
      <div className="bg-panel rounded-[22px] border border-line px-4 py-3 mb-4 flex items-center justify-between">
        <div className="text-sm">
          <span className="text-t3">全局天花板（AI_GLOBAL_MAX_LEVEL）：</span>
          <span className={`ml-1 text-xs px-2 py-0.5 rounded-full font-semibold ${LEVEL_STYLE[data.global.maxLevel] ?? ""}`}>
            {data.global.maxLevel}
          </span>
          {data.global.maxLevel === "L1" ? <span className="ml-2 text-danger-text font-semibold">（kill 狀態生效中）</span> : null}
        </div>
        <button
          disabled={!data.global.canPatch || killBusy}
          onClick={killAll}
          className={`text-sm px-4 py-2 rounded-full font-semibold ${
            data.global.canPatch ? "bg-danger text-panel hover:bg-danger/90" : "bg-line text-t3 cursor-not-allowed"
          }`}
          title={data.global.canPatch ? "全部店預設級降 L1" : "你唔喺調級白名單"}
        >
          {killBusy ? "執行中…" : "全店降 L1"}
        </button>
      </div>

      {/* 矩陣 */}
      <div className="bg-panel rounded-[22px] border border-line overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">店</th>
              {data.categories.map((c) => (
                <th key={c} className="text-left px-2 py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">
                  {c}
                  {data.lockedCategories.includes(c) ? <span className="ml-1 text-danger-text">🔒</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.clinics.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0 hover:bg-black/[.04]">
                <td className="px-3 py-2 align-top">
                  <div className="font-semibold text-t1">{c.code}</div>
                  <div className="text-xs text-t3">{c.name}</div>
                </td>
                {data.categories.map((cat) => {
                  const cell = c.cells[cat];
                  if (!cell) return <td key={cat} />;
                  if (cell.locked) {
                    return (
                      <td key={cat} className="px-2 py-2 align-top">
                        <span className="text-xs px-2 py-1 rounded-full bg-line text-t3">永遠人手</span>
                      </td>
                    );
                  }
                  return (
                    <td key={cat} className="px-2 py-2 align-top">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-semibold ${LEVEL_STYLE[cell.level] ?? ""}`}>{cell.level}</span>
                        {cell.eligible ? (
                          // ★ Fix D（cwi-fix-20260825-f1）：hover 講明採用率語義（autoSent 計採用）
                          <span className="text-ok-text text-xs" title={"符合自動化資格\n採用率 =（照用 + 修改後用 + 自動發出）÷ 草稿總數；自動發出計採用，投訴/回退零容忍"}>✓</span>
                        ) : (
                          <span className="text-t3 text-xs" title={cell.reasons.join("\n") + "\n採用率 =（照用 + 修改後用 + 自動發出）÷ 草稿總數；自動發出計採用，投訴/回退零容忍"}>
                            {cell.reasons.length > 0 ? "✗" : "–"}
                          </span>
                        )}
                      </div>
                      <div className="mt-1">
                        <Trend rates={cell.adoptRateTrend} />
                      </div>
                      <div
                        className="mt-1"
                        title={
                          cell.stats.map((s) => `${s.weekStart}: n=${s.draftCount} 投訴=${s.complaints} 回退=${s.rollbacks}`).join("\n") +
                          "\n採用率 =（照用 + 修改後用 + 自動發出）÷ 草稿總數；自動發出計採用，投訴/回退零容忍"
                        }
                      >
                        <LevelSelect clinicId={c.id} cat={cat} value={cell.level} disabled={!data.global.canPatch} onDone={load} />
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-t3 mt-2">
        走勢格 = 4 完整週 adoptRate（綠 ≥90% / 黃 ≥70% / 紅 &lt;70% / 灰 = 無樣本）。✗ hover 睇唔過原因。
      </p>
    </div>
  );
}
