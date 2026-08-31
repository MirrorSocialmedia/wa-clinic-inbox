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
import { io } from "socket.io-client";
import type { BookableSlotsResult, HeldItem } from "@/lib/workforce/client";

export interface SlotsData {
  connected: boolean;
  slots: BookableSlotsResult | null;
  held: HeldItem[];
  holdTimeoutHours: number | null;
  fetchedAt: string | null;
  // cwi-refresh-20260831 §5：L2 新鮮度（資料截至 / 可能滯後）
  syncedAt: string | null;
  stale: boolean;
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
// cwi-refresh-20260831 §5：新鮮度三態門檻
const FRESH_MS = 5 * 60 * 1000;
const STALE_MS = 20 * 60 * 1000;

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit" });
}

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
        if (seq === reqSeq.current) {
          setData({ connected: false, slots: null, held: [], holdTimeoutHours: null, fetchedAt: null, syncedAt: null, stale: false });
        }
        return;
      }
      const j = (await res.json()) as Omit<SlotsData, "fetchedAt">;
      if (seq === reqSeq.current) setData({ ...j, fetchedAt: new Date().toISOString() });
    } catch {
      if (seq === reqSeq.current) {
        setData({ connected: false, slots: null, held: [], holdTimeoutHours: null, fetchedAt: null, syncedAt: null, stale: false });
      }
    } finally {
      if (seq === reqSeq.current) setBusy(false);
    }
  }, []);

  // ── cwi-refresh-20260831 §4/§5：三步刷新鏈 + toast + 429 倒數 + 逐日失敗 + 403 橫額 ──
  const [refreshing, setRefreshing] = useState(false);
  const [disableSec, setDisableSec] = useState(0);
  const [toast, setToast] = useState<{ kind: "warn" | "err"; msg: string } | null>(null);
  const [failedDays, setFailedDays] = useState<string[]>([]);
  const [banner403, setBanner403] = useState(false);
  const retry409 = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((kind: "warn" | "err", msg: string) => {
    setToast({ kind, msg });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 8000);
  }, []);

  // 429 倒數 disable（MD §4：「啱啱先同步過，{n} 秒後再試」+ 掣 disable 倒數）
  useEffect(() => {
    if (disableSec <= 0) return;
    const t = setTimeout(() => setDisableSec((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [disableSec]);

  // 店切換時重置一次性 UI 狀態
  useEffect(() => {
    setBanner403(false);
    setFailedDays([]);
  }, [clinicCode]);

  // 三步刷新鏈（MD §4）：① POST /api/availability/refresh（dates=當前顯示日 ≤7）
  //   ② 200 → server 逐日 bust（route 內）③ 重讀重繪（load）
  const doRefresh = useCallback(
    async (is409Retry = false) => {
      if (refreshing || disableSec > 0 || !clinicCode) return;
      setRefreshing(true);
      const dates = view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(from, i)) : [from];
      try {
        const res = await fetch("/api/availability/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clinicCode, dates }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          refreshed?: Array<{ date: string; ok: boolean }>;
          retryAfterSec?: number;
        };
        if (res.ok) {
          setFailedDays((j.refreshed ?? []).filter((d) => !d.ok).map((d) => d.date));
          retry409.current = false;
          void load(clinicCode, from, view); // ③ 重讀重繪（server 已 bust + 重填）
          return;
        }
        setFailedDays([]);
        if (res.status === 429) {
          const n = j.retryAfterSec ?? 60;
          setDisableSec(n);
          showToast("warn", `啱啱先同步過，${n} 秒後再試`);
        } else if (res.status === 409) {
          if (!is409Retry && !retry409.current) {
            retry409.current = true;
            showToast("warn", "Apricot 忙緊，10 秒後自動重試一次");
            setTimeout(() => {
              retry409.current = false;
              void doRefreshRef.current(true);
            }, 10_000);
          } else {
            retry409.current = false;
            showToast("err", "Apricot 仍然忙緊 — 稍後再手動試");
          }
        } else if (res.status === 403) {
          setBanner403(true); // 403（scope 未加）→ 圖一現時橫額，文案照舊（MD §4）
        } else {
          showToast("err", "刷新失敗 — 請稍後再試");
        }
      } catch {
        showToast("err", "刷新失敗（網絡錯誤）");
      } finally {
        setRefreshing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshing, disableSec, clinicCode, from, view, load, showToast],
  );
  const doRefreshRef = useRef(doRefresh);
  useEffect(() => {
    doRefreshRef.current = doRefresh;
  }, [doRefresh]);

  // 寫入（任何 process：worker confirm / staff UI）→ L2 busted + 重填 → 即時重繪（MD §3）
  const loadArgsRef = useRef({ clinicCode, from, view });
  useEffect(() => {
    loadArgsRef.current = { clinicCode, from, view };
  }, [clinicCode, from, view]);
  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ["websocket", "polling"] });
    const onBusted = (p: { clinicCode?: string }) => {
      if (p && typeof p.clinicCode === "string" && p.clinicCode !== loadArgsRef.current.clinicCode) return;
      const a = loadArgsRef.current;
      void load(a.clinicCode, a.from, a.view);
    };
    socket.on("availability:busted", onBusted);
    return () => {
      socket.off("availability:busted", onBusted);
      socket.disconnect();
    };
  }, [load]);

  // 新鮮度三態（MD §5）：≤5m 綠「剛剛更新」/ 5–20m 灰「資料截至 HH:mm」/ >20m 黃底「資料可能滯後」
  const freshness = useMemo(() => {
    if (!data?.syncedAt) return null;
    const age = Date.now() - new Date(data.syncedAt).getTime();
    if (data.stale || age > STALE_MS) return { cls: "bg-warn-soft text-warn-text border-warn/70", label: "資料可能滯後 — 撳更新" };
    if (age <= FRESH_MS) return { cls: "bg-ok-soft text-ok-text border-ok/50", label: "剛剛更新" };
    return { cls: "bg-panel-2 text-t2 border-line", label: `資料截至 ${hhmm(data.syncedAt)}` };
    // fetchedAt 入 deps：每次 refetch 後重新評估年齡
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.syncedAt, data?.stale, data?.fetchedAt]);

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
          disabled={busy || refreshing || disableSec > 0}
          onClick={() => void doRefresh()}
          title={
            disableSec > 0
              ? `限流中（${disableSec}s 後再試）`
              : "立即同步（workforce → Apricot → 本地 cache 全鏈）"
          }
        >
          <RefreshCw size={12} className={refreshing || busy ? "animate-spin" : ""} />
          {disableSec > 0
            ? `${disableSec}s 後再試`
            : refreshing
              ? "同步中…"
              : data?.fetchedAt
                ? `更新 ${new Date(data.fetchedAt).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit" })}`
                : "更新"}
        </button>
        {freshness && (
          <span className={`text-[11px] px-2 py-1 rounded-md border inline-flex items-center ${freshness.cls}`}>
            {freshness.label}
          </span>
        )}
      </div>

      {/* toast（MD §4：UI 唔准靜靜失敗） */}
      {toast && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs mb-3 ${
            toast.kind === "warn" ? "bg-warn-soft border-warn text-warn-text" : "bg-danger-soft border-danger text-danger-text"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* 403 橫額（scope 未加 — 文案照舊，MD §4） */}
      {banner403 && (
        <div className="rounded-xl bg-danger-soft border border-warn p-3 text-sm text-danger-text text-center mb-3">
          clinic-workforce 未接通 — 讀唔到可約時段（key 失效或服務離線；5 分鐘後自動重試）
        </div>
      )}

      {/* 未接通（fail-soft — 同 /schedule 當值表嘅「未有資料」pattern） */}
      {data && !data.connected ? (
        <div className="rounded-xl bg-danger-soft border border-warn p-6 text-sm text-danger-text text-center">
          clinic-workforce 未接通 — 讀唔到可約時段（key 失效或服務離線；5 分鐘後自動重試）
        </div>
      ) : data?.slots ? (
        view === "week" ? (
          <WeekGrid dayIndex={dayIndex} heldByCell={heldByCell} from={from} today={today} failedDays={failedDays} />
        ) : (
          <DayGrid
            dayIndex={dayIndex}
            heldByCell={heldByCell}
            providers={dayProviders}
            from={from}
            today={today}
            failedDays={failedDays}
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
  failedDays,
}: {
  dayIndex: Map<string, { closed: boolean; byStart: Map<number, BookableSlotsResult["days"][number]["slots"]> }>;
  heldByCell: Map<string, HeldItem[]>;
  from: string;
  today: string;
  failedDays: string[];
}) {
  const failed = new Set(failedDays);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <div className="min-w-[720px]">
        {/* 日 header */}
        <div className="grid grid-cols-[52px_repeat(7,1fr)] border-b border-line">
          <div />
          {days.map((d) => {
            const closed = dayIndex.get(d)?.closed;
            const failedDay = failed.has(d);
            return (
              <div
                key={d}
                title={failedDay ? "呢日同步失敗（顯示最後已知數據）" : undefined}
                className={`px-1 py-1.5 text-center ${d === today ? "bg-brand-soft/60" : ""} ${failedDay ? "opacity-50" : ""}`}
              >
                <div className="text-[11px] font-semibold text-t1">
                  {weekdayCn(d)} {d.slice(5).replace("-", "/")}
                </div>
                {closed && <div className="text-[9.5px] text-t3">休診</div>}
                {failedDay && <div className="text-[9.5px] text-warn-text">同步失敗</div>}
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
              const failedDay = failed.has(d);
              let state: CellState = "full";
              let label = "";
              if (!day || day.closed) state = "closed";
              else if (failedDay) {
                // 該日同步失敗 → 全格灰 + hover 提示（MD §4）— 保留最後已知數據但降調
                state = "full";
              } else {
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
                    className={`h-[26px] rounded-[6px] border flex items-center justify-center text-[9.5px] font-medium ${CELL_CLS[state]} ${failedDay ? "opacity-50" : ""}`}
                    title={failedDay ? `呢日同步失敗 ${d} ${minToHHmm(m)}–${minToHHmm(m + 30)}` : `${d} ${minToHHmm(m)}–${minToHHmm(m + 30)}`}
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
  failedDays,
}: {
  dayIndex: Map<string, { closed: boolean; byStart: Map<number, BookableSlotsResult["days"][number]["slots"]> }>;
  heldByCell: Map<string, HeldItem[]>;
  providers: [string, string][];
  from: string;
  today: string;
  failedDays: string[];
}) {
  const day = dayIndex.get(from);
  const failedDay = failedDays.includes(from);
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
    <div>
      {failedDay && (
        <div className="rounded-lg bg-warn-soft border border-warn/70 px-3 py-2 text-xs text-warn-text mb-2">
          呢日同步失敗（顯示最後已知數據）— 撳「更新」重試
        </div>
      )}
      <div className={`overflow-x-auto rounded-xl border border-line bg-panel ${failedDay ? "opacity-50" : ""}`}>
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
    </div>
  );
}
