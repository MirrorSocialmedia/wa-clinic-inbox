"use client";

/**
 * 醫生時間表 board（cwi-sched-20260901 T-A 過渡版）
 *
 * 數據：GET /api/flows/slots?granularity=week|day（v2 provider 分組 — MD §2）
 *   days[] = { date, closed, duty[], providers[]（providerId/providerName/onlineSeats/slots?[]）}
 *   四態（MD §3；inbox 端無碎片數據 — MANUAL_ONLY 係保留值，現行管線唔會發出）：
 *     ONLINE = 可出（offerable）｜TAKEN = 已佔（HELD/IN_APRICOT 覆蓋）
 *     CLOSED = 未出線上（滿 / 早過 lead time / 冇數據 — external 唔會再分）｜休診日 = closed
 *   5 分鐘自動 refetch + 手動刷新（cwi-refresh §4 三步鏈）；fail-soft「未接通」pattern。
 *
 * 🔴 §5 修復：`useState(initialClinicCode)` 只係 initial — URL 換店（server select /
 *   舊 link / back-forward）傳新 prop 時 state 唔會跟住變 → 舊版零 fetch 零 network。
 *   現加 sync effect：prop 變 → setClinicCode → 下方 load effect 重 fetch。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { io } from "socket.io-client";
import type { FlowDay, FlowSlotsResult } from "@/lib/flow-slots";

export interface SlotsData extends FlowSlotsResult {
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
  initialData: FlowSlotsResult | null;
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

type CellState = "offerable" | "held" | "full";

const CELL_CLS: Record<CellState, string> = {
  offerable: "bg-ok-soft border-ok/50 text-ok-text",
  held: "bg-warn-soft border-warn/70 text-warn-text",
  full: "bg-panel-2 border-line text-t3",
};

const CLS_CLOSED_DAY =
  "bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.055)_0,rgba(0,0,0,0.055)_4px,transparent_4px,transparent_9px)] border-line text-t3";

export function SlotsBoard({ clinics, isStaff, initialClinicCode, initialView, initialData, today }: Props) {
  const [clinicCode, setClinicCode] = useState(initialClinicCode);
  const [view, setView] = useState<"week" | "day">(initialView);
  const [from, setFrom] = useState(today);
  const [data, setData] = useState<SlotsData | null>(
    initialData ? { ...initialData, fetchedAt: new Date().toISOString() } : null
  );
  const [busy, setBusy] = useState(false);
  const [banner403, setBanner403] = useState(false);

  // 🔴 §5 修復：URL-driven 換店 → sync prop 入 state（漏咗呢個 = 零 fetch 零 network）
  useEffect(() => {
    setClinicCode((c) => (c === initialClinicCode ? c : initialClinicCode));
  }, [initialClinicCode]);

  const reqSeq = useRef(0);

  const windowEnd = view === "week" ? addDays(from, 6) : from;

  const load = useCallback(async (cc: string, f: string, v: "week" | "day") => {
    if (!cc) return;
    const seq = ++reqSeq.current;
    setBusy(true);
    try {
      const to = v === "week" ? addDays(f, 6) : f;
      const res = await fetch(
        `/api/flows/slots?clinicCode=${encodeURIComponent(cc)}&from=${f}&to=${to}&granularity=${v}`
      );
      if (!res.ok) {
        if (seq === reqSeq.current) {
          if (res.status === 403) setBanner403(true);
          setData({ ...EMPTY_DATA, connected: false, fetchedAt: null });
        }
        return;
      }
      const j = (await res.json()) as FlowSlotsResult;
      if (seq === reqSeq.current) setData({ ...j, fetchedAt: new Date().toISOString() });
    } catch {
      if (seq === reqSeq.current) {
        setData({ ...EMPTY_DATA, connected: false, fetchedAt: null });
      }
    } finally {
      if (seq === reqSeq.current) setBusy(false);
    }
  }, []);

  // ── cwi-refresh-20260831 §4/§5：三步刷新鏈 + toast + 429 倒數 + 403 橫額 ──
  const [refreshing, setRefreshing] = useState(false);
  const [disableSec, setDisableSec] = useState(0);
  const [toast, setToast] = useState<{ kind: "warn" | "err"; msg: string } | null>(null);
  const [failedDays, setFailedDays] = useState<string[]>([]);
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

  // ── 索引（days → byDate）──────────────────────────────────────────────
  const dayMap = useMemo(() => {
    const m = new Map<string, FlowDay>();
    for (const d of data?.days ?? []) m.set(d.date, d);
    return m;
  }, [data?.days]);

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

  const weekDays: string[] = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const dayViewDay = dayMap.get(from) ?? null;

  return (
    <div className="space-y-3">
      {/* 工具列：view 切換 + 日/週 nav + 刷新 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0.5 bg-panel-2 rounded-full p-0.5">
          {(["week", "day"] as const).map((v) => (
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

      {/* 部分日同步失敗（refresh dates[] 逐日 ok — v2 shape 冇 per-day 狀態，只係橫額提示） */}
      {failedDays.length > 0 && (
        <div className="rounded-lg bg-warn-soft border border-warn/70 px-3 py-2 text-xs text-warn-text">
          部分日同步失敗：{failedDays.join("、")} — 顯示最後已知數據，撳「更新」重試
        </div>
      )}

      {/* 未接通（fail-soft — 同 /schedule 當值表嘅「未有資料」pattern） */}
      {data && !data.connected ? (
        <div className="rounded-xl bg-danger-soft border border-warn p-6 text-sm text-danger-text text-center">
          clinic-workforce 未接通 — 讀唔到可約時段（key 失效或服務離線；5 分鐘後自動重試）
        </div>
      ) : data ? (
        view === "week" ? (
          <WeekCells
            days={weekDays.map((d) => dayMap.get(d) ?? null)}
            today={today}
            onDayClick={(d) => {
              setFrom(d);
              setView("day");
            }}
          />
        ) : (
          <DayGrid day={dayViewDay} from={from} today={today} />
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
          <span className={`w-[22px] h-[14px] rounded-[5px] ${CLS_CLOSED_DAY}`} /> 休診
        </span>
        <span className="ml-auto text-t3">來源 clinic-workforce · 每 5 分鐘刷新 · 48 格 × 30 分鐘</span>
      </div>
    </div>
  );
}

/** v2 空數據（load fail fallback — connected=false 觸發「未接通」pattern）。 */
const EMPTY_DATA: FlowSlotsResult = {
  ok: true, v: 2, clinicCode: "", from: "", to: "", granularity: "week",
  connected: false, syncedAt: null, stale: false, days: [],
};

// ── 週視圖：每日一格 = 日期 + 當值副標題 + 逐醫生一行（名 + 剩餘席）────────
// 醫生多過 3 個 → 頭 3 個 + 「+N 位只開診冇預約」（MD §1；providers 已按席數降冪排）。
function WeekCells({
  days,
  today,
  onDayClick,
}: {
  days: (FlowDay | null)[];
  today: string;
  onDayClick: (date: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px] grid grid-cols-7 gap-2">
        {days.map((day, i) => (
          <button
            key={day?.date ?? i}
            type="button"
            onClick={() => day && onDayClick(day.date)}
            title={day ? `睇 ${day.date} 日視圖` : undefined}
            className={`text-left rounded-xl p-2.5 space-y-2 hover:bg-brand-soft/40 transition-colors ${
              day?.closed ? CLS_CLOSED_DAY : i === 0 ? "bg-brand-soft/60" : "bg-panel-2"
            }`}
          >
            <div className="text-[11px] font-semibold text-t1 flex items-center gap-1 flex-wrap">
              {day ? `${weekdayCn(day.date)} ${day.date.slice(5).replace("-", "/")}` : "—"}
              {day?.date === today && (
                <span className="text-[9px] px-1 rounded bg-brand-soft text-brand-text">今日</span>
              )}
              {day?.closed && <span className="text-[9px] px-1 rounded bg-panel text-t3">休診</span>}
            </div>
            {day && day.duty.length > 0 && (
              <div className="text-[10.5px] text-t2 leading-snug">
                當值：{day.duty.map((e) => `${e.staffName}${e.role ? ` · ${e.role}` : ""}`).join("、")}
              </div>
            )}
            {day && day.providers.length > 0 ? (
              <div className="space-y-1">
                {day.providers.slice(0, 3).map((p) => (
                  <div key={p.providerId} className="rounded bg-canvas/60 px-1.5 py-1 text-[11px] leading-snug">
                    <div className="text-t1">{p.providerName}</div>
                    <div className={p.onlineSeats > 0 ? "text-ok-text" : "text-t3"}>
                      {p.onlineSeats > 0 ? `${p.onlineSeats} 席` : "冇位"}
                    </div>
                  </div>
                ))}
                {day.providers.length > 3 && (
                  <div className="text-[10.5px] text-t3">+{day.providers.length - 3} 位只開診冇預約</div>
                )}
              </div>
            ) : (
              day && (
                <div className="text-[11px] text-t3 py-1">
                  {day.closed ? "冇醫生當值" : "無醫生數據"}
                </div>
              )
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 日視圖：48 半時格 × 醫生欄（provider 分組 — T-B 會改單醫生 chips）──────
function DayGrid({ day, from, today }: { day: FlowDay | null; from: string; today: string }) {
  if (!day) {
    return <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">未有資料（workforce 未回該日數據）</div>;
  }
  if (day.closed) {
    return (
      <div className={`rounded-xl ${CLS_CLOSED_DAY} border p-8 text-sm text-t3 text-center`}>
        休診日（冇醫生當值）
      </div>
    );
  }
  if (day.providers.length === 0) {
    return <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">當日無醫生有可出位（全滿或未同步）</div>;
  }
  const cols = day.providers.length;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <div style={{ minWidth: `${52 + cols * 130}px` }}>
        <div className="grid border-b border-line" style={{ gridTemplateColumns: `52px repeat(${cols}, 1fr)` }}>
          <div />
          {day.providers.map((p) => (
            <div
              key={p.providerId}
              className={`px-1 py-1.5 text-center text-[11px] font-semibold text-t1 ${from === today ? "bg-brand-soft/60" : ""}`}
            >
              {p.providerName}
              {p.onlineSeats > 0 && <span className="text-ok-text text-[10px]">（{p.onlineSeats} 席）</span>}
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
            {day.providers.map((p) => {
              // day granularity：API 只回非 CLOSED 格 — 缺 = CLOSED（full 格視覺）
              const slot = p.slots?.find((s) => s.start === minToHHmm(m));
              let state: CellState = "full";
              let label = "";
              if (slot?.state === "TAKEN") {
                state = "held";
                label = "已佔";
              } else if (slot?.state === "ONLINE" || slot?.state === "MANUAL_ONLY") {
                state = "offerable";
                label = `${slot.seats} 席`;
              }
              return (
                <div key={p.providerId} className="p-px">
                  <div
                    className={`h-[26px] rounded-[6px] border flex items-center justify-center text-[10px] font-medium ${CELL_CLS[state]}`}
                    title={`${p.providerName} ${minToHHmm(m)}–${minToHHmm(m + 30)}`}
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
