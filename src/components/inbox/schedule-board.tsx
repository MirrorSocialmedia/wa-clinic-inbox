"use client";

/**
 * 醫生時間表 board（cwi-sched-20260901 §1/§3/§6 — 合併頁）
 *
 * 數據：GET /api/flows/slots?granularity=week|day（v2 provider 分組 — MD §2）
 *   days[] = { date, closed, duty[], providers[]（providerId/providerName/onlineSeats/slots?[]）}
 *   四態（§3 文案表 — 逐字）：
 *     ONLINE      = 可上線約（病人自己約得，Flow／AI 會出呢啲時段）
 *     MANUAL_ONLY = 只可人手約（碎片時段，AI 唔會出，前台可以人手安排）— 保留值，現行管線唔發出
 *     TAKEN       = 已佔（有人揀緊或者已落單，等入 Apricot）
 *     CLOSED      = 唔開診・滿（醫生冇開診，或者已滿／太趕）
 *
 * 導航架構（§1 URL 帶齊 state）：**URL = 唯一真相** — 日格 / chips / 返週表 / view 切換 /
 *   週日 nav 全部係 `<a href>` 真導航（server 重 render 出正確 view + 數據）。
 *   實測教訓：client router.replace 喺 server-component 頁會同 RSC 重 render 鬥 —
 *   replace 有時吞咗（URL 唔變）→ 本 board 刻意唔用 client 端 view/date state。
 *   唯一 client 行為：5 分鐘 refetch + socket busted 重讀 + 更新掣（fetch，唔導航）。
 *
 * 🔴 §5 修復（T-A）：舊版 `useState(initialClinicCode)` 唔 sync prop → 換店零 fetch。
 *   現 board 冇 clinic state — prop 直接來自 URL（server 已解析），load effect 跟 prop。
 *
 * 刷新（§6，承接 cwi-refresh-20260831 §4/§5）：一粒更新掣，三步鏈
 *   ① POST /api/availability/refresh（週視圖 = 當前 7 日；日視圖 = 該日 1 日 — 慳 Apricot）
 *   ② 200 → server 逐日 bust ③ 重讀重繪（load）。新鮮度三態：≤5m 綠 / 5–20m 灰 / >20m 黃底。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { io } from "socket.io-client";
import type { FlowDay, FlowSlotsResult, FlowProvider } from "@/lib/flow-slots";

type BoardData = FlowSlotsResult & { fetchedAt: string | null };

interface ClinicOpt {
  id: string;
  code: string;
  name: string;
}

interface Props {
  clinics: ClinicOpt[];
  /** 目前店（server 由 URL 解析 — §4 全店唯讀） */
  clinicCode: string;
  view: "week" | "day";
  /** week = 窗口首日；day = 該日（server 已 clamp 今日..+20） */
  date: string;
  provider: string;
  initialData: FlowSlotsResult | null;
  today: string;
}

const SLOT_MINUTES: number[] = Array.from({ length: 48 }, (_, i) => i * 30);
const REFETCH_MS = 5 * 60 * 1000;
const MAX_AHEAD_DAYS = 20;
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

/** URL builder — 導航全部經呢度（ clinic 必帶；view/day 視圖帶 date；provider 跟緊）。 */
function href(clinic: string, view: "week" | "day", date?: string, provider?: string): string {
  const p = new URLSearchParams();
  p.set("clinic", clinic);
  p.set("view", view);
  if (view === "day" && date) p.set("date", date);
  if (view === "day" && provider) p.set("provider", provider);
  else if (view === "week" && date) p.set("date", date);
  return `/schedule?${p.toString()}`;
}

// §3 文案表（逐字）— 四態 → 顯示文案 + hover 說明
type CellState = "ONLINE" | "MANUAL_ONLY" | "TAKEN" | "CLOSED";
const CELL_COPY: Record<CellState, { label: string; hover: string }> = {
  ONLINE: { label: "可上線約", hover: "病人自己約得，Flow／AI 會出呢啲時段" },
  MANUAL_ONLY: { label: "只可人手約", hover: "碎片時段，AI 唔會出，前台可以人手安排" },
  TAKEN: { label: "已佔", hover: "有人揀緊或者已落單，等入 Apricot" },
  CLOSED: { label: "唔開診・滿", hover: "醫生冇開診，或者已滿／太趕" },
};

const CELL_CLS: Record<CellState, string> = {
  ONLINE: "bg-ok-soft border-ok/50 text-ok-text",
  MANUAL_ONLY: "bg-panel border-dashed border-warn text-warn-text",
  TAKEN: "bg-warn-soft border-warn/70 text-warn-text",
  CLOSED: "bg-panel-2 border-line text-t3",
};

const CLS_CLOSED_DAY =
  "bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.055)_0,rgba(0,0,0,0.055)_4px,transparent_4px,transparent_9px)] border-line text-t3";

const EMPTY_DATA: FlowSlotsResult = {
  ok: true, v: 2, clinicCode: "", from: "", to: "", granularity: "week",
  connected: false, syncedAt: null, stale: false, days: [],
};

export function ScheduleBoard({
  clinics,
  clinicCode,
  view,
  date,
  provider,
  initialData,
  today,
}: Props) {
  void clinics; // 選單喺 page header（ClinicSelect）
  const [data, setData] = useState<BoardData | null>(
    initialData ? { ...initialData, fetchedAt: new Date().toISOString() } : null
  );
  const [busy, setBusy] = useState(false);
  const [banner403, setBanner403] = useState(false);
  const reqSeq = useRef(0);
  const argsRef = useRef({ clinicCode, view, date });

  const load = useCallback(async (cc: string, v: "week" | "day", d: string) => {
    if (!cc) return;
    const seq = ++reqSeq.current;
    setBusy(true);
    try {
      // 週視圖：d = 窗口首日；日視圖：d = 該日
      const fromStr = d;
      const toStr = v === "week" ? addDays(d, 6) : d;
      const res = await fetch(
        `/api/flows/slots?clinicCode=${encodeURIComponent(cc)}&from=${fromStr}&to=${toStr}&granularity=${v}`
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
      if (seq === reqSeq.current) setData({ ...EMPTY_DATA, connected: false, fetchedAt: null });
    } finally {
      if (seq === reqSeq.current) setBusy(false);
    }
  }, []);

  // 店 / 視圖 / 日期（= URL）變 → fetch + 5 分鐘 refetch
  useEffect(() => {
    argsRef.current = { clinicCode, view, date };
    if (!clinicCode) return;
    void load(clinicCode, view, date);
    const t = setInterval(() => void load(clinicCode, view, date), REFETCH_MS);
    return () => clearInterval(t);
  }, [clinicCode, view, date, load]);

  // ── §6 更新掣：三步刷新鏈 + toast + 429 倒數 + 403 橫額 ─────────────────
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

  // §6：週視圖刷 7 日 / 日視圖刷 1 日（慳 Apricot）
  const doRefresh = useCallback(
    async (is409Retry = false) => {
      if (refreshing || disableSec > 0 || !clinicCode) return;
      setRefreshing(true);
      const dates = view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(date, i)) : [date];
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
          void load(clinicCode, view, date); // ③ 重讀重繪（server 已 bust + 重填）
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
          setBanner403(true);
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
    [refreshing, disableSec, clinicCode, view, date, load, showToast],
  );
  const doRefreshRef = useRef(doRefresh);
  useEffect(() => {
    doRefreshRef.current = doRefresh;
  }, [doRefresh]);

  // 寫入（任何 process）→ L2 busted + 重填 → 即時重繪（cwi-refresh §3）
  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ["websocket", "polling"] });
    const onBusted = (p: { clinicCode?: string }) => {
      if (p && typeof p.clinicCode === "string" && p.clinicCode !== argsRef.current.clinicCode) return;
      const a = argsRef.current;
      void load(a.clinicCode, a.view, a.date);
    };
    socket.on("availability:busted", onBusted);
    return () => {
      socket.off("availability:busted", onBusted);
      socket.disconnect();
    };
  }, [load]);

  // 新鮮度三態（cwi-refresh §5）
  const freshness = useMemo(() => {
    if (!data?.syncedAt) return null;
    const age = Date.now() - new Date(data.syncedAt).getTime();
    if (data.stale || age > STALE_MS) return { cls: "bg-warn-soft text-warn-text border-warn/70", label: "資料可能滯後 — 撳更新" };
    if (age <= FRESH_MS) return { cls: "bg-ok-soft text-ok-text border-ok/50", label: "剛剛更新" };
    return { cls: "bg-panel-2 text-t2 border-line", label: `資料截至 ${hhmm(data.syncedAt)}` };
    // fetchedAt 入 deps：每次 refetch 後重新評估年齡
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.syncedAt, data?.stale, data?.fetchedAt]);

  // ── 索引 ────────────────────────────────────────────────────────────────
  const dayMap = useMemo(() => {
    const m = new Map<string, FlowDay>();
    for (const d of data?.days ?? []) m.set(d.date, d);
    return m;
  }, [data?.days]);

  // 日視圖 provider chips：default 第一個有席嘅醫生（§1）
  const dayViewDay = view === "day" ? dayMap.get(date) ?? null : null;
  const chipProviders = dayViewDay?.providers ?? [];
  const activeProvider: FlowProvider | null = useMemo(() => {
    if (chipProviders.length === 0) return null;
    return chipProviders.find((p) => p.providerId === provider) ?? chipProviders.find((p) => p.onlineSeats > 0) ?? chipProviders[0];
  }, [chipProviders, provider]);

  if (!clinicCode) {
    return <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">冇店可顯示。</div>;
  }

  const canPrev = view === "week" || date > today;
  const canNext = addDays(date, view === "week" ? 7 : 1) <= addDays(today, MAX_AHEAD_DAYS);

  const navBtn =
    "inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-line bg-panel text-t2 hover:bg-panel-2 disabled:opacity-40 disabled:pointer-events-none";

  const weekDays: string[] = Array.from({ length: 7 }, (_, i) => addDays(date, i));

  // 日視圖 → 週視圖：返今日嗰個週窗口（date 參數捨去 — 見 href 註）
  const weekFromDay = href(clinicCode, "week");
  const dayFromWeek = href(clinicCode, "day", date);

  return (
    <div className="space-y-3">
      {/* 工具列：view 切換 + 週/日 nav + 更新掣（§6 一粒）+ 新鮮度 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0.5 bg-panel-2 rounded-full p-0.5">
          <a
            href={view === "week" ? "#" : weekFromDay}
            aria-disabled={view === "week"}
            className={`text-xs px-2.5 py-1 rounded-full font-medium ${
              view === "week" ? "bg-brand text-panel" : "text-t2 hover:text-t1"
            }`}
          >
            週
          </a>
          <a
            href={view === "day" ? "#" : dayFromWeek}
            aria-disabled={view === "day"}
            className={`text-xs px-2.5 py-1 rounded-full font-medium ${
              view === "day" ? "bg-brand text-panel" : "text-t2 hover:text-t1"
            }`}
          >
            日
          </a>
        </div>
        <a
          href={canPrev ? href(clinicCode, view, addDays(date, view === "week" ? -7 : -1)) : "#"}
          aria-disabled={!canPrev}
          className={navBtn}
        >
          ← {view === "week" ? "上週" : "上一日"}
        </a>
        <span className="text-xs font-semibold text-t1 font-mono">
          {date}
          {view === "week" ? ` – ${addDays(date, 6)}` : ""}
        </span>
        <a
          href={canNext ? href(clinicCode, view, addDays(date, view === "week" ? 7 : 1)) : "#"}
          aria-disabled={!canNext}
          className={navBtn}
        >
          {view === "week" ? "下週" : "下一日"} →
        </a>
        <button
          className={`${navBtn} ml-auto`}
          disabled={busy || refreshing || disableSec > 0}
          onClick={() => void doRefresh()}
          title={disableSec > 0 ? `限流中（${disableSec}s 後再試）` : "立即同步（workforce → Apricot → 本地 cache 全鏈）"}
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

      {/* toast（UI 唔准靜靜失敗） */}
      {toast && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs mb-3 ${
            toast.kind === "warn" ? "bg-warn-soft border-warn text-warn-text" : "bg-danger-soft border-danger text-danger-text"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {banner403 && (
        <div className="rounded-xl bg-danger-soft border border-warn p-3 text-sm text-danger-text text-center mb-3">
          clinic-workforce 未接通 — 讀唔到時間表（key 失效或服務離線；5 分鐘後自動重試）
        </div>
      )}

      {failedDays.length > 0 && (
        <div className="rounded-lg bg-warn-soft border border-warn/70 px-3 py-2 text-xs text-warn-text">
          部分日同步失敗：{failedDays.join("、")} — 顯示最後已知數據，撳「更新」重試
        </div>
      )}

      {/* 內容 */}
      {data && !data.connected ? (
        <div className="rounded-xl bg-danger-soft border border-warn p-6 text-sm text-danger-text text-center">
          clinic-workforce 未接通 — 讀唔到時間表（key 失效或服務離線；5 分鐘後自動重試）
        </div>
      ) : data ? (
        view === "week" ? (
          <WeekCells days={weekDays.map((d) => dayMap.get(d) ?? null)} today={today} clinic={clinicCode} />
        ) : (
          <DayGrid
            day={dayViewDay}
            date={date}
            today={today}
            clinic={clinicCode}
            providers={chipProviders}
            activeProvider={activeProvider}
          />
        )
      ) : (
        <div className="rounded-xl bg-panel-2 p-8 text-center">
          <div className="text-sm text-t1 font-medium">{busy ? "載入中…" : "未有資料"}</div>
          <div className="text-xs text-t3 mt-1">時間表嚟自 clinic-workforce（未接入或本週無排更）</div>
        </div>
      )}

      {/* 圖例（§3 文案表 — 編碼唔自解，必須有） */}
      <div className="flex items-center gap-4 flex-wrap text-[11px] text-t2">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-[22px] h-[14px] rounded-[5px] bg-ok-soft border border-ok/50" /> 可上線約
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-[22px] h-[14px] rounded-[5px] bg-panel border border-dashed border-warn" /> 只可人手約
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-[22px] h-[14px] rounded-[5px] bg-warn-soft border border-warn/70" /> 已佔
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-[22px] h-[14px] rounded-[5px] bg-panel-2 border border-line" /> 唔開診・滿
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`w-[22px] h-[14px] rounded-[5px] ${CLS_CLOSED_DAY}`} /> 休診
        </span>
        <span className="ml-auto text-t3">來源 clinic-workforce · 每 5 分鐘刷新 · 48 格 × 30 分鐘</span>
      </div>
    </div>
  );
}

// ── 週視圖：每日一格 = 日期 + 當值副標題 + 逐醫生一行（名 + 剩餘席）────────
// 醫生多過 3 個 → 頭 3 個 + 「+N 位只開診冇預約」（§1；providers 已按席數降冪排）。
// 撳日格 = 真導航 view=day&date=…（§1 URL 帶齊 state）。
function WeekCells({
  days,
  today,
  clinic,
}: {
  days: (FlowDay | null)[];
  today: string;
  clinic: string;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px] grid grid-cols-7 gap-2">
        {days.map((day, i) => (
          <a
            key={day?.date ?? i}
            href={day ? href(clinic, "day", day.date) : "#"}
            title={day ? `睇 ${day.date} 日視圖` : undefined}
            className={`block text-left rounded-xl p-2.5 space-y-2 hover:bg-brand-soft/40 transition-colors ${
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
                <div className="text-[11px] text-t3 py-1">{day.closed ? "冇醫生當值" : "無醫生數據"}</div>
              )
            )}
          </a>
        ))}
      </div>
    </div>
  );
}

// ── 日視圖：頂部醫生 chips（default 第一有席）+ 48 格（30 分鐘）+ 返週表掣（§1）─
function DayGrid({
  day,
  date,
  today,
  clinic,
  providers,
  activeProvider,
}: {
  day: FlowDay | null;
  date: string;
  today: string;
  clinic: string;
  providers: FlowProvider[];
  activeProvider: FlowProvider | null;
}) {
  if (!day) {
    return <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">未有資料（workforce 未回該日數據）</div>;
  }
  if (day.closed) {
    return (
      <div className="space-y-3">
        <BackWeekBar clinic={clinic} />
        <div className={`rounded-xl ${CLS_CLOSED_DAY} border p-8 text-sm text-t3 text-center`}>休診日（冇醫生當值）</div>
      </div>
    );
  }
  if (providers.length === 0 || !activeProvider) {
    return (
      <div className="space-y-3">
        <BackWeekBar clinic={clinic} />
        <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">當日無醫生可上線約（全滿或未同步）</div>
      </div>
    );
  }
  const p = activeProvider;
  return (
    <div className="space-y-3">
      <BackWeekBar clinic={clinic} />
      {/* 醫生 chips（default 第一個有席 — §1；chip = 真導航帶 provider） */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {providers.map((cp) => (
          <a
            key={cp.providerId}
            href={href(clinic, "day", date, cp.providerId)}
            className={`text-xs px-2.5 py-1 rounded-full border ${
              cp.providerId === p.providerId
                ? "bg-brand text-panel border-brand font-semibold"
                : "bg-panel text-t2 border-line hover:bg-panel-2"
            }`}
          >
            {cp.providerName}
            {cp.onlineSeats > 0 && <span className={cp.providerId === p.providerId ? "opacity-80" : "text-ok-text"}>（{cp.onlineSeats} 席）</span>}
          </a>
        ))}
      </div>
      {/* 48 格 × 30 分鐘（該醫生；缺格 = CLOSED） */}
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <div className="min-w-[220px]">
          <div className="grid grid-cols-[52px_1fr] border-b border-line">
            <div />
            <div className={`px-1 py-1.5 text-center text-[11px] font-semibold text-t1 ${date === today ? "bg-brand-soft/60" : ""}`}>
              {p.providerName}
            </div>
          </div>
          {SLOT_MINUTES.map((m) => {
            const slot = p.slots?.find((s) => s.start === minToHHmm(m));
            const state: CellState = slot ? slot.state : "CLOSED";
            const copy = CELL_COPY[state];
            return (
              <div key={m} className={`grid grid-cols-[52px_1fr] items-stretch ${m % 60 === 0 ? "border-t border-line" : ""}`}>
                <div
                  className={`px-1 flex items-end justify-end pb-0.5 font-mono ${
                    m % 60 === 0 ? "text-[10.5px] font-semibold text-t1" : "text-[9.5px] text-t3"
                  }`}
                >
                  {minToHHmm(m)}
                </div>
                <div className="p-px">
                  <div
                    className={`h-[26px] rounded-[6px] border flex items-center justify-center gap-1 text-[10px] font-medium ${CELL_CLS[state]}`}
                    title={`${p.providerName} ${minToHHmm(m)}–${minToHHmm(m + 30)}：${copy.hover}`}
                  >
                    {copy.label}
                    {state === "ONLINE" && slot && <span className="opacity-75">{slot.seats} 席</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BackWeekBar({ clinic }: { clinic: string }) {
  return (
    <div className="flex items-center gap-2">
      <a
        href={href(clinic, "week")}
        className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-line bg-panel text-t2 hover:bg-panel-2"
      >
        ← 返週表
      </a>
    </div>
  );
}
