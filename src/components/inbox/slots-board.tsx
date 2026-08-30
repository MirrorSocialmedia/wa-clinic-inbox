"use client";

/**
 * 醫生時間表（可約時段）四態格（providerslot-20260830 T3 — MD §六 / 設計稿 3a）
 *
 * 數據：GET /api/flows/slots → workforce bookable-slots（只出 offerable 格）+ held（HELD/IN_APRICOT）。
 * 四態（inbox 端無碎片數據 — MD §五：碎片格唔顯示）：
 *   綠 = 可出（offerable 存在）｜橙 = 已佔（HELD 覆蓋，未入 Apricot）
 *   灰 = 未出線上（滿 / 早過 lead time / 冇同步數據 — external API 唔會再分）
 *   斜紋 = 休診日（closed）
 * 行為：5 分鐘自動 refetch + 手動刷新；API 連唔到 = 「未接通」pattern（inbox fail-soft 慣例）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { BookableSlotsResult, HeldItem } from "@/lib/workforce/client";

export interface SlotsData {
  connected: boolean;
  slots: BookableSlotsResult | null;
  held: HeldItem[];
  holdTimeoutHours: number | null;
  fetchedAt: string | null;
}

interface ClinicOpt {
  id: string;
  code: string;
  name: string;
}

interface Props {
  clinics: ClinicOpt[];
  isStaff: boolean;
  initialClinicCode: string;
  initialView: "week" | "day";
  initialData: SlotsData | null;
  today: string;
}

const SLOT_MINUTES: number[] = Array.from({ length: 48 }, (_, i) => i * 30);
const REFETCH_MS = 5 * 60 * 1000;
const MAX_AHEAD_DAYS = 20; // flow 窗口保護（workforce 會 clamp，呢度只係唔俾人亂跳）

function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function addDays(dateStr: string, n: number): string {
  // 純日曆日運算：按 UTC 午夜解（+08:00 解會令 toISOString 跨日界 — 實測 -1 日 bug）
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayCn(dateStr: string): string {
  return new Intl.DateTimeFormat("zh-HK", { timeZone: "Asia/Hong_Kong", weekday: "short" }).format(
    new Date(`${dateStr}T00:00:00+08:00`)
  );
}

type CellState = "offerable" | "held" | "full" | "closed";

const CELL_CLS: Record<CellState, string> = {
  offerable: "bg-ok-soft border-ok/50 text-ok-text",
  held: "bg-warn-soft border-warn/70 text-warn-text",
  full: "bg-panel-2 border-line text-t3",
  closed:
    "bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.055)_0,rgba(0,0,0,0.055)_4px,transparent_4px,transparent_9px)] border-line text-t3",
};

export function SlotsBoard({ clinics, isStaff, initialClinicCode, initialView, initialData, today }: Props) {
  const [clinicCode, setClinicCode] = useState(initialClinicCode);
  const [view, setView] = useState<"week" | "day">(initialView);
  const [from, setFrom] = useState(today);
  const [data, setData] = useState<SlotsData | null>(initialData);
  const [busy, setBusy] = useState(false);
  const reqSeq = useRef(0);

  const windowEnd = view === "week" ? addDays(from, 6) : from;

  const load = useCallback(async (cc: string, f: string, v: "week" | "day") => {
    if (!cc) return;
    const seq = ++reqSeq.current;
    setBusy(true);
    try {
      const to = v === "week" ? addDays(f, 6) : f;
      const res = await fetch(`/api/flows/slots?clinicCode=${encodeURIComponent(cc)}&from=${f}&to=${to}`);
      if (!res.ok) {
        if (seq === reqSeq.current) setData({ connected: false, slots: null, held: [], holdTimeoutHours: null, fetchedAt: null });
        return;
      }
      const j = (await res.json()) as Omit<SlotsData, "fetchedAt">;
      if (seq === reqSeq.current) setData({ ...j, fetchedAt: new Date().toISOString() });
    } catch {
      if (seq === reqSeq.current) setData({ connected: false, slots: null, held: [], holdTimeoutHours: null, fetchedAt: null });
    } finally {
      if (seq === reqSeq.current) setBusy(false);
    }
  }, []);

  // 5 分鐘 refetch（視圖/店/日期變即拉一次）
  useEffect(() => {
    if (!clinicCode) return;
    void load(clinicCode, from, view);
    const t = setInterval(() => void load(clinicCode, from, view), REFETCH_MS);
    return () => clearInterval(t);
  }, [clinicCode, from, view, load]);

  // ── 索引（days → byStart；held → 格）──────────────────────────────
  const dayIndex = useMemo(() => {
    const m = new Map<string, { closed: boolean; byStart: Map<number, BookableSlotsResult["days"][number]["slots"]> }>();
    for (const d of data?.slots?.days ?? []) {
      const byStart = new Map<number, BookableSlotsResult["days"][number]["slots"]>();
      for (const s of d.slots) {
        // start = "HH:MM"（workforce 契約 — 實測；之前以為 HH:MM:SS 解出 NaN → 全格灰）
        const [hh, mnt] = s.start.split(":");
        const startMin = Number(hh) * 60 + Number(mnt);
        const list = byStart.get(startMin) ?? [];
        list.push(s);
        byStart.set(startMin, list);
      }
      m.set(d.date, { closed: d.closed, byStart });
    }
    return m;
  }, [data]);

  const heldByCell = useMemo(() => {
    const m = new Map<string, HeldItem[]>();
    for (const h of data?.held ?? []) {
      if (h.status !== "HELD") continue; // IN_APRICOT = 已落單，唔係「線上已佔」
      const k = `${h.date}|${h.startMin}`;
      const list = m.get(k) ?? [];
      list.push(h);
      m.set(k, list);
    }
    return m;
  }, [data]);

  // 日視圖：該日 provider 清單（offerable ∪ HELD — 全滿但有 hold 嘅醫生都要見到）
  const dayProviders = useMemo(() => {
    const set = new Map<string, string>(); // providerId → name
    const d = dayIndex.get(from);
    if (d) {
      for (const list of d.byStart.values()) for (const s of list) set.set(s.providerId, s.providerName);
    }
    for (const h of data?.held ?? []) {
      if (h.date === from && h.status === "HELD") set.set(h.providerId, h.providerName);
    }
    return [...set.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-HK"));
  }, [dayIndex, data, from]);

  if (!clinicCode) {
    return (
      <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">
        揀一間店先睇醫生時間表。
      </div>
    );
  }

  const canPrev = from > today;
  const canNext = from < addDays(today, MAX_AHEAD_DAYS);

  const navBtn =
    "inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-line bg-panel text-t2 hover:bg-panel-2 disabled:opacity-40 disabled:pointer-events-none";

  return (
    <div className="space-y-3">
      {/* 工具列：view 切換 + 日/週 nav + 店選單 + 刷新 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0.5 bg-panel-2 rounded-full p-0.5">
          {(["day", "week"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                view === v ? "bg-brand text-panel" : "text-t2 hover:text-t1"
              }`}
            >
              {v === "day" ? "日" : "週"}
            </button>
          ))}
        </div>
        <button className={navBtn} disabled={!canPrev} onClick={() => setFrom((f) => addDays(f, view === "week" ? -7 : -1))}>
          ← {view === "week" ? "上週" : "上一日"}
        </button>
        <span className="text-xs font-semibold text-t1 font-mono">
          {from}
          {view === "week" ? ` – ${windowEnd}` : ""}
        </span>
        <button
          className={navBtn}
          disabled={!canNext}
          onClick={() => setFrom((f) => addDays(f, view === "week" ? 7 : 1))}
        >
          {view === "week" ? "下週" : "下一日"} →
        </button>
        {!isStaff && clinics.length > 1 && (
          <select
            value={clinicCode}
            onChange={(e) => setClinicCode(e.target.value)}
            className="text-xs px-2 py-1 rounded bg-panel border border-line text-t1"
          >
            {clinics.map((c) => (
              <option key={c.id} value={c.code}>
                {c.name}（{c.code}）
              </option>
            ))}
          </select>
        )}
        <button
          className={`${navBtn} ml-auto`}
          disabled={busy}
          onClick={() => void load(clinicCode, from, view)}
          title="手動刷新（5 分鐘自動）"
        >
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
          {data?.fetchedAt
            ? `更新 ${new Date(data.fetchedAt).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit" })}`
            : "刷新"}
        </button>
      </div>

      {/* 未接通（fail-soft — 同 /schedule 當值表嘅「未有資料」pattern） */}
      {data && !data.connected ? (
        <div className="rounded-xl bg-danger-soft border border-warn p-6 text-sm text-danger-text text-center">
          clinic-workforce 未接通 — 讀唔到可約時段（key 失效或服務離線；5 分鐘後自動重試）
        </div>
      ) : data?.slots ? (
        view === "week" ? (
          <WeekGrid dayIndex={dayIndex} heldByCell={heldByCell} from={from} today={today} />
        ) : (
          <DayGrid
            dayIndex={dayIndex}
            heldByCell={heldByCell}
            providers={dayProviders}
            from={from}
            today={today}
          />
        )
      ) : (
        <div className="rounded-xl bg-panel-2 p-8 text-center">
          <div className="text-sm text-t1 font-medium">{busy ? "載入中…" : "未有資料"}</div>
          <div className="text-xs text-t3 mt-1">可約時段嚟自 clinic-workforce（未接入或本週無排更）</div>
        </div>
      )}

      {/* 圖例（3a 鐵律：編碼唔自解 — 必須有） */}
      <div className="flex items-center gap-4 flex-wrap text-[11px] text-t2">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-[22px] h-[14px] rounded-[5px] bg-ok-soft border border-ok/50" /> 可出（線上可出位）
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-[22px] h-[14px] rounded-[5px] bg-warn-soft border border-warn/70" /> 已佔（HELD · 未入 Apricot）
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-[22px] h-[14px] rounded-[5px] bg-panel-2 border border-line" /> 未出線上（滿 / 早過 lead time）
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-[22px] h-[14px] rounded-[5px] bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.055)_0,rgba(0,0,0,0.055)_4px,transparent_4px,transparent_9px)] border border-line" />
          休診
        </span>
        <span className="ml-auto text-t3">來源 clinic-workforce · 每 5 分鐘刷新 · 48 格 × 30 分鐘</span>
      </div>
    </div>
  );
}

// ── 週視圖：7 日 × 48 半時格（aggregate 全醫生）────────────────────────

function WeekGrid({
  dayIndex,
  heldByCell,
  from,
  today,
}: {
  dayIndex: Map<string, { closed: boolean; byStart: Map<number, BookableSlotsResult["days"][number]["slots"]> }>;
  heldByCell: Map<string, HeldItem[]>;
  from: string;
  today: string;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <div className="min-w-[720px]">
        {/* 日 header */}
        <div className="grid grid-cols-[52px_repeat(7,1fr)] border-b border-line">
          <div />
          {days.map((d) => {
            const closed = dayIndex.get(d)?.closed;
            return (
              <div key={d} className={`px-1 py-1.5 text-center ${d === today ? "bg-brand-soft/60" : ""}`}>
                <div className="text-[11px] font-semibold text-t1">
                  {weekdayCn(d)} {d.slice(5).replace("-", "/")}
                </div>
                {closed && <div className="text-[9.5px] text-t3">休診</div>}
              </div>
            );
          })}
        </div>
        {/* 48 行 */}
        {SLOT_MINUTES.map((m) => (
          <div
            key={m}
            className={`grid grid-cols-[52px_repeat(7,1fr)] items-stretch ${m % 60 === 0 ? "border-t border-line" : ""}`}
          >
            <div
              className={`px-1 flex items-end justify-end pb-0.5 font-mono ${
                m % 60 === 0 ? "text-[10.5px] font-semibold text-t1" : "text-[9.5px] text-t3"
              }`}
            >
              {minToHHmm(m)}
            </div>
            {days.map((d) => {
              const day = dayIndex.get(d);
              let state: CellState = "full";
              let label = "";
              if (!day || day.closed) state = "closed";
              else {
                // held 優先於 offerable（3a：橙邊 = 線上已佔未入 Apricot — 有 hold 就要見到，
                // 唔好俾另一醫生有出位就蓋住）
                const held = heldByCell.get(`${d}|${m}`);
                if (held && held.length > 0) {
                  state = "held";
                  label = "已佔";
                } else {
                  const list = day.byStart.get(m);
                  if (list && list.length > 0) {
                    state = "offerable";
                    label = list.length > 1 ? `${list.length} 格` : "可出";
                  }
                }
              }
              return (
                <div key={d} className="p-px">
                  <div
                    className={`h-[26px] rounded-[6px] border flex items-center justify-center text-[9.5px] font-medium ${CELL_CLS[state]}`}
                    title={`${d} ${minToHHmm(m)}–${minToHHmm(m + 30)}`}
                  >
                    {label}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 日視圖：48 半時格 × 醫生欄（provider 層）──────────────────────────

function DayGrid({
  dayIndex,
  heldByCell,
  providers,
  from,
  today,
}: {
  dayIndex: Map<string, { closed: boolean; byStart: Map<number, BookableSlotsResult["days"][number]["slots"]> }>;
  heldByCell: Map<string, HeldItem[]>;
  providers: [string, string][];
  from: string;
  today: string;
}) {
  const day = dayIndex.get(from);
  if (!day) {
    return <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">未有資料（該日冇任何可出格或 hold）</div>;
  }
  if (day.closed) {
    return (
      <div className="rounded-xl bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.055)_0,rgba(0,0,0,0.055)_4px,transparent_4px,transparent_9px)] border border-line p-8 text-sm text-t3 text-center">
        休診日（冇醫生當值）
      </div>
    );
  }
  if (providers.length === 0) {
    return <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">當日無醫生有可出位（全滿或未同步）</div>;
  }
  const cols = providers.length;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <div style={{ minWidth: `${52 + cols * 130}px` }}>
        <div className="grid border-b border-line" style={{ gridTemplateColumns: `52px repeat(${cols}, 1fr)` }}>
          <div />
          {providers.map(([pid, name]) => (
            <div key={pid} className={`px-1 py-1.5 text-center text-[11px] font-semibold text-t1 ${from === today ? "bg-brand-soft/60" : ""}`}>
              {name}
            </div>
          ))}
        </div>
        {SLOT_MINUTES.map((m) => (
          <div
            key={m}
            className={`grid items-stretch ${m % 60 === 0 ? "border-t border-line" : ""}`}
            style={{ gridTemplateColumns: `52px repeat(${cols}, 1fr)` }}
          >
            <div
              className={`px-1 flex items-end justify-end pb-0.5 font-mono ${
                m % 60 === 0 ? "text-[10.5px] font-semibold text-t1" : "text-[9.5px] text-t3"
              }`}
            >
              {minToHHmm(m)}
            </div>
            {providers.map(([pid, name]) => {
              const slots = day.byStart.get(m) ?? [];
              const mine = slots.find((s) => s.providerId === pid);
              const held = heldByCell.get(`${from}|${m}`)?.find((h) => h.providerId === pid);
              let state: CellState = "full";
              let label = "";
              if (mine) {
                state = "offerable";
                label = `${mine.seatsFree} 席`;
              } else if (held) {
                state = "held";
                label = "已佔";
              }
              return (
                <div key={pid} className="p-px">
                  <div
                    className={`h-[26px] rounded-[6px] border flex items-center justify-center text-[10px] font-medium ${CELL_CLS[state]}`}
                    title={`${name} ${minToHHmm(m)}–${minToHHmm(m + 30)}`}
                  >
                    {label}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
