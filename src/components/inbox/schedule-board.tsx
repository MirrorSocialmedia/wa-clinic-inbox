"use client";

/**
 * 醫生時間表 board(cwi-sched-20260901 §1/§3/§6 - 合併頁)
 *
 * 數據:GET /api/flows/slots?granularity=week|day(v2 provider 分組 - MD §2)
 *   days[] = { date, closed, duty[], providers[](providerId/providerName/onlineSeats/slots?[])}
 *   四態(§3 文案表 - 逐字):
 *     ONLINE      = 可上線約(病人自己約得,Flow/AI 會出呢啲時段)
 *     MANUAL_ONLY = 只可人手約(碎片時段,AI 唔會出,前台可以人手安排)- 保留值,現行管線唔發出
 *     TAKEN       = 已佔(有人揀緊或者已落單,等入 Apricot)
 *     CLOSED      = 唔開診・滿(醫生冇開診,或者已滿/太趕)
 *
 * 導航架構(§1 URL 帶齊 state):**URL = 唯一真相** - 日格 / chips / 返週表 / view 切換 /
 *   週日 nav 全部係 `<a href>` 真導航(server 重 render 出正確 view + 數據)。
 *   實測教訓:client router.replace 喺 server-component 頁會同 RSC 重 render 鬥 -
 *   replace 有時吞咗(URL 唔變)→ 本 board 刻意唔用 client 端 view/date state。
 *   唯一 client 行為:5 分鐘 refetch + socket busted 重讀 + 更新掣(fetch,唔導航)。
 *
 * 🔴 §5 修復(T-A):舊版 `useState(initialClinicCode)` 唔 sync prop → 換店零 fetch。
 *   現 board 冇 clinic state - prop 直接來自 URL(server 已解析),load effect 跟 prop。
 *
 * 刷新(§6,承接 cwi-refresh-20260831 §4/§5):一粒更新掣,三步鏈
 *   1 POST /api/availability/refresh(週視圖 = 當前 7 日;日視圖 = 該日 1 日 - 慳 Apricot)
 *   2 200 → server 逐日 bust 3 重讀重繪(load)。新鮮度三態:≤5m 綠 / 5-20m 灰 / >20m 黃底。
 */
import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { RefreshCw } from "lucide-react";
import { io } from "socket.io-client";
import type { FlowDay, FlowSlot, FlowSlotsResult, FlowProvider } from "@/lib/flow-slots";
import type { ConversationItem } from "./types";
import { WindowExits } from "./window-exits";
import { hkNowMin, hhmmToMin } from "./time";

type BoardData = FlowSlotsResult & { fetchedAt: string | null };

interface ClinicOpt {
  id: string;
  code: string;
  name: string;
}

interface Props {
  clinics: ClinicOpt[];
  /** 目前店(server 由 URL 解析 - §4 全店唯讀) */
  clinicCode: string;
  view: "week" | "day";
  /** week = 窗口首日;day = 該日(server 已 clamp 今日..+20) */
  date: string;
  provider: string;
  initialData: FlowSlotsResult | null;
  today: string;
  /** D.3(cwi-schedv2-20260903):目前用戶 staffId(popover 三出路 lock 判定用) */
  myStaffId: string;
}

const SLOT_MINUTES: number[] = Array.from({ length: 48 }, (_, i) => i * 30);
const REFETCH_MS = 5 * 60 * 1000;
const MAX_AHEAD_DAYS = 20;
// cwi-refresh-20260831 §5:新鮮度三態門檻
const FRESH_MS = 5 * 60 * 1000;
const STALE_MS = 20 * 60 * 1000;

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit" });
}

function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function addDays(dateStr: string, n: number): string {
  // 純日曆日運算:按 UTC 午夜解(+08:00 解會令 toISOString 跨日界 - 實測 -1 日 bug)
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayCn(dateStr: string): string {
  return new Intl.DateTimeFormat("zh-HK", { timeZone: "Asia/Hong_Kong", weekday: "short" }).format(
    new Date(`${dateStr}T00:00:00+08:00`)
  );
}

/** URL builder - 導航全部經呢度( clinic 必帶;view/day 視圖帶 date;provider 跟緊)。 */
function href(clinic: string, view: "week" | "day", date?: string, provider?: string): string {
  const p = new URLSearchParams();
  p.set("clinic", clinic);
  p.set("view", view);
  if (view === "day" && date) p.set("date", date);
  if (view === "day" && provider) p.set("provider", provider);
  else if (view === "week" && date) p.set("date", date);
  return `/schedule?${p.toString()}`;
}

// §3 文案表(逐字)- 四態 → 顯示文案 + hover 說明
type CellState = "ONLINE" | "MANUAL_ONLY" | "TAKEN" | "CLOSED";
const CELL_COPY: Record<CellState, { label: string; hover: string }> = {
  ONLINE: { label: "可上線約", hover: "病人自己約得,Flow/AI 會出呢啲時段" },
  MANUAL_ONLY: { label: "只可人手約", hover: "碎片時段,AI 唔會出,前台可以人手安排" },
  TAKEN: { label: "已佔", hover: "有人揀緊或者已落單,等入 Apricot" },
  CLOSED: { label: "唔開診・滿", hover: "醫生冇開診,或者已滿/太趕" },
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
  myStaffId,
}: Props) {
  void clinics; // 選單喺 page header(ClinicSelect)
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
      // 週視圖:d = 窗口首日;日視圖:d = 該日
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

  // 店 / 視圖 / 日期(= URL)變 → fetch + 5 分鐘 refetch
  useEffect(() => {
    argsRef.current = { clinicCode, view, date };
    if (!clinicCode) return;
    void load(clinicCode, view, date);
    const t = setInterval(() => void load(clinicCode, view, date), REFETCH_MS);
    return () => clearInterval(t);
  }, [clinicCode, view, date, load]);

  // ── §6 更新掣:三步刷新鏈 + toast + 429 倒數 + 403 橫額 ─────────────────
  const [refreshing, setRefreshing] = useState(false);
  const [disableSec, setDisableSec] = useState(0);
  const [toast, setToast] = useState<{ kind: "ok" | "warn" | "err"; msg: string } | null>(null);
  const [failedDays, setFailedDays] = useState<string[]>([]);
  const retry409 = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((kind: "ok" | "warn" | "err", msg: string) => {
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

  // §6:週視圖刷 7 日 / 日視圖刷 1 日(慳 Apricot)
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
          void load(clinicCode, view, date); // 3 重讀重繪(server 已 bust + 重填)
          return;
        }
        setFailedDays([]);
        if (res.status === 429) {
          const n = j.retryAfterSec ?? 60;
          setDisableSec(n);
          showToast("warn", `啱啱先同步過,${n} 秒後再試`);
        } else if (res.status === 409) {
          if (!is409Retry && !retry409.current) {
            retry409.current = true;
            showToast("warn", "Apricot 忙緊,10 秒後自動重試一次");
            setTimeout(() => {
              retry409.current = false;
              void doRefreshRef.current(true);
            }, 10_000);
          } else {
            retry409.current = false;
            showToast("err", "Apricot 仍然忙緊 - 稍後再手動試");
          }
        } else if (res.status === 403) {
          setBanner403(true);
        } else {
          showToast("err", "刷新失敗 - 請稍後再試");
        }
      } catch {
        showToast("err", "刷新失敗(網絡錯誤)");
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

  // 寫入(任何 process)→ L2 busted + 重填 → 即時重繪(cwi-refresh §3)
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

  // 新鮮度三態(cwi-refresh §5)
  const freshness = useMemo(() => {
    if (!data?.syncedAt) return null;
    const age = Date.now() - new Date(data.syncedAt).getTime();
    if (data.stale || age > STALE_MS) return { cls: "bg-warn-soft text-warn-text border-warn/70", label: "資料可能滯後 - 撳更新" };
    if (age <= FRESH_MS) return { cls: "bg-ok-soft text-ok-text border-ok/50", label: "剛剛更新" };
    return { cls: "bg-panel-2 text-t2 border-line", label: `資料截至 ${hhmm(data.syncedAt)}` };
    // fetchedAt 入 deps:每次 refetch 後重新評估年齡
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.syncedAt, data?.stale, data?.fetchedAt]);

  // ── 索引 ────────────────────────────────────────────────────────────────
  const dayMap = useMemo(() => {
    const m = new Map<string, FlowDay>();
    for (const d of data?.days ?? []) m.set(d.date, d);
    return m;
  }, [data?.days]);

  // 日視圖 provider chips:default 第一個有席嘅醫生(§1)
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

  // 日視圖 → 週視圖:返今日嗰個週窗口(date 參數捨去 - 見 href 註)
  const weekFromDay = href(clinicCode, "week");
  const dayFromWeek = href(clinicCode, "day", date);

  return (
    <div className="space-y-3">
      {/* 工具列:view 切換 + 週/日 nav + 更新掣(§6 一粒)+ 新鮮度 */}
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
          {view === "week" ? ` - ${addDays(date, 6)}` : ""}
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
          title={disableSec > 0 ? `限流中(${disableSec}s 後再試)` : "立即同步(workforce → Apricot → 本地 cache 全鏈)"}
        >
          <RefreshCw size={12} className={refreshing || busy ? "animate-spin" : ""} />
          {disableSec > 0
            ? `${disableSec}s 後再試`
            : refreshing
              ? "同步中..."
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

      {/* toast(UI 唔准靜靜失敗) */}
      {toast && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs mb-3 ${
            toast.kind === "ok"
              ? "bg-ok-soft border-ok text-ok-text"
              : toast.kind === "warn"
                ? "bg-warn-soft border-warn text-warn-text"
                : "bg-danger-soft border-danger text-danger-text"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {banner403 && (
        <div className="rounded-xl bg-danger-soft border border-warn p-3 text-sm text-danger-text text-center mb-3">
          clinic-workforce 未接通 - 讀唔到時間表(key 失效或服務離線;5 分鐘後自動重試)
        </div>
      )}

      {failedDays.length > 0 && (
        <div className="rounded-lg bg-warn-soft border border-warn/70 px-3 py-2 text-xs text-warn-text">
          部分日同步失敗:{failedDays.join("、")} - 顯示最後已知數據,撳「更新」重試
        </div>
      )}

      {/* 內容 */}
      {data && !data.connected ? (
        <div className="rounded-xl bg-danger-soft border border-warn p-6 text-sm text-danger-text text-center">
          clinic-workforce 未接通 - 讀唔到時間表(key 失效或服務離線;5 分鐘後自動重試)
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
            clinicId={clinics.find((c) => c.code === clinicCode)?.id ?? ""}
            myStaffId={myStaffId}
            providers={chipProviders}
            activeProvider={activeProvider}
            onToast={showToast}
          />
        )
      ) : (
        <div className="rounded-xl bg-panel-2 p-8 text-center">
          <div className="text-sm text-t1 font-medium">{busy ? "載入中..." : "未有資料"}</div>
          <div className="text-xs text-t3 mt-1">時間表嚟自 clinic-workforce(未接入或本週無排更)</div>
        </div>
      )}

      {/* 圖例(§3 文案表 - 編碼唔自解,必須有) */}
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

// ── 週視圖:每日一格 = 日期 + 當值副標題 + 逐醫生一行(名 + 剩餘席)────────
// 醫生多過 3 個 → 頭 3 個 + 「+N 位只開診冇預約」(§1;providers 已按席數降冪排)。
// 撳日格 = 真導航 view=day&date=...(§1 URL 帶齊 state)。
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
              {day ? `${weekdayCn(day.date)} ${day.date.slice(5).replace("-", "/")}` : "-"}
              {day?.date === today && (
                <span className="text-[9px] px-1 rounded bg-brand-soft text-brand-text">今日</span>
              )}
              {day?.closed && <span className="text-[9px] px-1 rounded bg-panel text-t3">休診</span>}
            </div>
            {day && day.duty.length > 0 && (
              <div className="text-[10.5px] text-t2 leading-snug">
                當值:{day.duty.map((e) => `${e.staffName}${e.role ? ` · ${e.role}` : ""}`).join("、")}
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

// ── 日視圖：頂部醫生 chips（default 第一有席）+ 時段格（30 分鐘）+ 返週表掣（§1）──
// D.1（cwi-schedv2-20260903）：只 render API 回嘅非 CLOSED 格；前後 CLOSED 段各摺一行（純 UI 展開，無 refetch）；
//   今日：past 格 opacity:.45（保留唔摺）+ 首次 auto-scroll 到「而家」行（block:center）+
//   而家線（— 而家 / 2px var(--brand)）插喺相鄰格之間，60s tick（unmount clear）。
// D.2：ONLINE 格席位點 ■（剩）/□（佔），共 = capacity（server 端 max(seats) fallback + warn；G-4 補真值）。
// D.3：ONLINE 格可撳 → 幫病人約 popover（既有對話搜尋 → 揀 → 發 Flow prefill；
//   過窗 → 三出路）。
// G-3（cwi-writeword-20260904）：popover 加埋〔人手落單〕掣（同 Flow 並存 — 直接行代落單
//   寫入鏈入 Apricot，病人唔使行 Flow；只收已釘住舊客 — 新客 422 鐵律；Send Lock 423）。
type DayRow =
  | { kind: "slot"; key: string; m: number; slot: FlowSlot }
  | { kind: "gap"; key: string; from: number; to: number };

function rangeMins(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; m < to; m += 30) out.push(m);
  return out;
}

/** D.1 摺疊行（CLOSED 段一行 — 展開/收埋純 UI） */
function GapRow({ label, onClick, expanded }: { label: string; onClick: () => void; expanded?: boolean }) {
  return (
    <div className="grid grid-cols-[52px_1fr] items-stretch">
      <div />
      <div className="p-px">
        <button
          type="button"
          onClick={onClick}
          aria-expanded={expanded}
          title="展開／收埋唔開診時段"
          className={`h-[28px] w-full rounded-[6px] border border-dashed text-[10px] cursor-pointer ${
            expanded ? "bg-panel-2 text-t2 border-line hover:opacity-80" : `${CLS_CLOSED_DAY} hover:opacity-80`
          }`}
        >
          {label}
        </button>
      </div>
    </div>
  );
}

function DayGrid({
  day,
  date,
  today,
  clinic,
  clinicId,
  myStaffId,
  providers,
  activeProvider,
  onToast,
}: {
  day: FlowDay | null;
  date: string;
  today: string;
  clinic: string;
  clinicId: string;
  myStaffId: string;
  providers: FlowProvider[];
  activeProvider: FlowProvider | null;
  onToast?: (kind: "ok" | "warn" | "err", msg: string) => void;
}) {
  const isToday = date === today;
  const p = activeProvider;

  // D.1：摺疊段（純 UI state，換日/換醫生重置）
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set());
  const toggleGap = useCallback((key: string) => {
    setExpandedGaps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // D.1：而家分鐘（今日先有；60s tick，unmount clear）
  // D.1：nowMin 初始 = -1（SSR 同 client 首 render 一致 → 無 hydration mismatch）；
  // 而家線喺 mount 後 effect 先出現（實測：SSR 用 server 時間 render 而家線 → 與 frozen/不同時區 client 首 render 位置唔同 → mismatch）
  const [nowMin, setNowMin] = useState<number>(-1);
  // D.3 popover state
  const [pop, setPop] = useState<{ m: number; slot: FlowSlot } | null>(null);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [hits, setHits] = useState<{ id: string; waId: string; profileName: string | null }[] | null>(null);
  const [convs, setConvs] = useState<ConversationItem[] | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [manualBusy, setManualBusy] = useState(false); // G-3 人手落單
  const [popErr, setPopErr] = useState<string | null>(null);
  const [raceConv, setRaceConv] = useState<ConversationItem | null>(null); // 422 競態 → 三出路

  useEffect(() => {
    setExpandedGaps(new Set());
    setPop(null);
    setQ("");
    setHits(null);
    setConvs(null);
    setSelId(null);
    setPopErr(null);
    setRaceConv(null);
    setManualBusy(false);
  }, [date, p?.providerId]);

  // D.1：60s tick（今日先）
  useEffect(() => {
    if (!isToday) {
      setNowMin(-1);
      return;
    }
    setNowMin(hkNowMin());
    const t = setInterval(() => setNowMin(hkNowMin()), 60_000);
    return () => clearInterval(t);
  }, [isToday]);

  // 行 = 存在格 + 缺口段（缺 = CLOSED）
  const rows = useMemo<DayRow[]>(() => {
    if (!p?.slots) return [];
    const byMin = new Map<number, FlowSlot>();
    for (const s of p.slots) {
      const m = hhmmToMin(s.start);
      if (m !== null) byMin.set(m, s);
    }
    const out: DayRow[] = [];
    let gapStart: number | null = null;
    for (const m of SLOT_MINUTES) {
      const slot = byMin.get(m);
      if (slot) {
        if (gapStart !== null) {
          out.push({ kind: "gap", key: `gap-${gapStart}-${m}`, from: gapStart, to: m });
          gapStart = null;
        }
        out.push({ kind: "slot", key: `slot-${m}`, m, slot });
      } else if (gapStart === null) {
        gapStart = m;
      }
    }
    if (gapStart !== null) out.push({ kind: "gap", key: `gap-${gapStart}-1440`, from: gapStart, to: 1440 });
    return out;
  }, [p]);

  // 而家線位置：第一條 end > nowMin 嘅行之前（全部結束 → 放尾）
  const nowIdx = useMemo(() => {
    if (!isToday || nowMin < 0) return -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const end = r.kind === "gap" ? r.to : r.m + 30;
      if (end > nowMin) return i;
    }
    return rows.length;
  }, [rows, isToday, nowMin]);

  // D.1：首次 auto-scroll 到而家線（今日 + 每 date/provider 一次）
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrolledKey = useRef("");
  useEffect(() => {
    if (!isToday || !p || rows.length === 0) return;
    const key = `${date}|${p.providerId}`;
    if (scrolledKey.current === key) return;
    const el = gridRef.current?.querySelector<HTMLElement>("[data-now-line]");
    if (!el) return; // rows/nowMin 未 render 完 — rows/nowMin 變會再觸發（nowMin 初始 -1 → effect 後先出線）
    scrolledKey.current = key;
    el.scrollIntoView({ block: "center" });
  }, [isToday, p, date, rows, nowMin]);

  // D.3：popover 開 → 拉既有對話名單（一次）
  useEffect(() => {
    if (!pop || !clinicId) return;
    let alive = true;
    setConvs(null);
    fetch(`/api/conversations?clinicId=${encodeURIComponent(clinicId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive) setConvs(Array.isArray(j) ? (j as ConversationItem[]) : []);
      })
      .catch(() => {
        if (alive) setConvs([]);
      });
    return () => {
      alive = false;
    };
  }, [pop, clinicId]);

  // D.3：病人搜尋（debounce 300ms）— 搜該店既有 contact
  useEffect(() => {
    if (!pop) return;
    const query = q.trim();
    if (!query) {
      setHits(null);
      setSearching(false);
      setSearchErr(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      (async () => {
        try {
          const res = await fetch(
            `/api/search?type=contact&q=${encodeURIComponent(query)}&clinicId=${encodeURIComponent(clinicId)}`
          );
          if (!res.ok) {
            setSearchErr(res.status === 403 ? "你只可以幫自己店嘅病人約" : "搜尋失敗（重試）");
            setHits([]);
            return;
          }
          const j = (await res.json().catch(() => null)) as {
            results?: { id: string; waId: string; profileName: string | null }[];
          } | null;
          setSearchErr(null);
          setHits(Array.isArray(j?.results) ? j.results : []);
        } catch {
          setSearchErr("搜尋失敗（網絡錯誤）");
          setHits([]);
        }
        setSearching(false);
      })();
    }, 300);
    return () => clearTimeout(t);
  }, [q, pop, clinicId]);

  const selConv = selId && convs ? convs.find((c) => c.id === selId) ?? null : null;

  async function sendFlow(conv: ConversationItem) {
    if (!pop || !p || sending) return;
    setSending(true);
    setPopErr(null);
    try {
      const res = await fetch(`/api/conversations/${conv.id}/flows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prefill: { date, providerId: p.providerId, start: pop.slot.start },
        }),
      });
      const j = (await res.json().catch(() => null)) as {
        ok?: boolean;
        reused?: boolean;
        error?: string;
      } | null;
      if (res.ok) {
        onToast?.("ok", j?.reused ? "呢格 Flow 已經出過（冪等複用）" : "已發預約連結（Flow · 已鎖定呢格）");
        setPop(null);
        setQ("");
        setHits(null);
        setSelId(null);
        setRaceConv(null);
        setPopErr(null);
      } else if (res.status === 422) {
        // 窗口剛過（前端 state 之後嘅競態）→ 三出路
        setRaceConv(conv);
      } else if (res.status === 423) {
        setPopErr("此對話已有負責人 — 發唔到 Flow（可喺 inbox 撳接手）");
      } else {
        setPopErr(j?.error ?? `發送失敗（${res.status}）`);
      }
    } catch {
      setPopErr("發送失敗（網絡錯誤）");
    }
    setSending(false);
  }

  // G-3：人手落單 — 直接行代落單寫入鏈入 Apricot（病人唔使行 Flow）。
  // 前端預檢：selConv 要有已釘住舊客（pinnedPatientApricotId）— 無 = 新客路徑唔存在（422 鐵律）。
  // visit reason 唔帶 = server 用 BOOKING_DEFAULT_VISIT_REASON_CODE env 模式（跟 cwi-bkui 現狀）。
  // 成功後 board 經 availability:busted socket 自動重繪（createBooking 已 bust 該日 L2）。
  async function sendManual(conv: ConversationItem) {
    if (!pop || !p || manualBusy) return;
    if (!conv.pinnedPatientApricotId) return; // UI gate（server 再擋一道 422）
    setManualBusy(true);
    setPopErr(null);
    try {
      const res = await fetch("/api/bookings/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conv.id,
          providerApricotId: p.providerId,
          providerName: p.providerName,
          date,
          start: pop.slot.start,
        }),
      });
      const j = (await res.json().catch(() => null)) as {
        ok?: boolean;
        apricotApptId?: string;
        error?: string;
        message?: string;
        autoMessage?: { sent: boolean; reason?: string; hint?: string };
      } | null;
      if (res.ok) {
        // 200：成功 + 窗口內自動確認訊息已入隊
        onToast?.("ok", `已喺 Apricot 落單（單號 ${j?.apricotApptId ?? "…"}）— 確認訊息已自動發`);
        setPop(null);
        setQ("");
        setHits(null);
        setSelId(null);
        setRaceConv(null);
        setPopErr(null);
      } else if (res.status === 422 && j?.ok === true) {
        // 200 語義但 422：booking 已成（CONFIRMED），只是自動確認訊息出唔到（過窗/隊列）
        onToast?.("warn", `已喺 Apricot 落單（單號 ${j?.apricotApptId ?? "…"}）— ${j?.autoMessage?.hint ?? "請手動覆病人"}`);
        setPop(null);
        setQ("");
        setHits(null);
        setSelId(null);
        setRaceConv(null);
        setPopErr(null);
      } else if (res.status === 409) {
        setPopErr(j?.error === "pending_exists" ? "呢個時段已有待處理預約（對話卡可跟進）" : (j?.message ?? "時段啱啱滿咗 — 撳更新重揀"));
      } else if (res.status === 423) {
        setPopErr("此對話已有負責人 — 落唔到單（可喺 inbox 撳接手）");
      } else {
        setPopErr(j?.message ?? `落單失敗（${res.status}）`);
      }
    } catch {
      setPopErr("落單失敗（網絡錯誤）");
    }
    setManualBusy(false);
  }

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
  if (providers.length === 0 || !p) {
    return (
      <div className="space-y-3">
        <BackWeekBar clinic={clinic} />
        <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">當日無醫生可上線約（全滿或未同步）</div>
      </div>
    );
  }

  // D.2 席位點（■ 剩 / □ 佔；共 = capacity）
  const dots = (slot: FlowSlot) => {
    const cap = p.capacity;
    if (cap == null || cap <= 0) return null;
    const left = Math.max(0, Math.min(slot.seats, cap));
    const taken = Math.max(0, cap - slot.seats);
    return (
      <span
        aria-label={`剩 ${slot.seats} 席，共 ${cap} 席`}
        title={`剩 ${slot.seats} 席，共 ${cap} 席`}
        className="tracking-tighter font-mono"
      >
        {"■".repeat(left)}
        {"□".repeat(taken)}
      </span>
    );
  };

  const gapLabel = (g: { from: number; to: number }) => {
    if (g.from === 0 && g.to === 1440) return "全日唔開診 · 展開";
    if (g.from === 0) return `↑ ${minToHHmm(g.to)} 之前（唔開診）· 展開`;
    if (g.to === 1440) return `↓ ${minToHHmm(g.from)} 之後（唔開診）· 展開`;
    return `${minToHHmm(g.from)}–${minToHHmm(g.to)} 唔開診 · 展開`;
  };

  const renderSlotRow = (m: number, slot: FlowSlot | undefined, faded: boolean) => {
    const state: CellState = slot ? slot.state : "CLOSED";
    const copy = CELL_COPY[state];
    const clickable = state === "ONLINE" && !!slot;
    return (
      <div
        key={`slot-${m}`}
        className={`grid grid-cols-[52px_1fr] items-stretch ${m % 60 === 0 ? "border-t border-line" : ""} ${faded ? "opacity-45" : ""}`}
      >
        <div
          className={`px-1 flex items-end justify-end pb-0.5 font-mono ${
            m % 60 === 0 ? "text-[10.5px] font-semibold text-t1" : "text-[9.5px] text-t3"
          }`}
        >
          {minToHHmm(m)}
        </div>
        <div className="p-px">
          {clickable ? (
            <button
              type="button"
              onClick={() => setPop({ m, slot: slot! })}
              className={`h-[26px] w-full rounded-[6px] border flex items-center justify-center gap-1 text-[10px] font-medium cursor-pointer hover:brightness-95 ${CELL_CLS[state]}`}
              title={`${p.providerName} ${minToHHmm(m)}–${minToHHmm(m + 30)}：${copy.hover}（撳 = 幫病人約）`}
            >
              {dots(slot!)}
              {copy.label}
              <span className="opacity-75">{slot!.seats} 席</span>
            </button>
          ) : (
            <div
              className={`h-[26px] rounded-[6px] border flex items-center justify-center gap-1 text-[10px] font-medium ${CELL_CLS[state]}`}
              title={`${p.providerName} ${minToHHmm(m)}–${minToHHmm(m + 30)}：${copy.hover}`}
            >
              {copy.label}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderNowLine = (
    <div key="now-line" data-now-line="1" aria-label="而家" className="grid grid-cols-[52px_1fr] items-stretch">
      <div className="px-1 flex items-center justify-end text-[9px] font-bold text-brand-text">— 而家</div>
      <div className="p-px pt-[4px]">
        <div className="h-0" style={{ borderTop: "2px solid var(--brand)" }} />
      </div>
    </div>
  );

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
      {/* 時段格（D.1：只 render 非 CLOSED 格 + 缺口摺行；今日 = 淡化 + 而家線 + auto-scroll） */}
      <div ref={gridRef} className="overflow-x-auto rounded-xl border border-line bg-panel">
        <div className="min-w-[220px]">
          <div className="grid grid-cols-[52px_1fr] border-b border-line">
            <div />
            <div className={`px-1 py-1.5 text-center text-[11px] font-semibold text-t1 ${date === today ? "bg-brand-soft/60" : ""}`}>
              {p.providerName}
            </div>
          </div>
          {rows.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-t3">今日冇可約時段（全日唔開診或未同步）</div>
          )}
          {rows.map((r, i) => (
            <Fragment key={r.key}>
              {nowIdx === i && renderNowLine}
              {r.kind === "slot" ? (
                renderSlotRow(r.m, r.slot, isToday && nowMin >= 0 && r.m + 30 <= nowMin)
              ) : expandedGaps.has(r.key) ? (
                <>
                  <GapRow label={gapLabel(r).replace("· 展開", "· 收埋")} onClick={() => toggleGap(r.key)} expanded />
                  {rangeMins(r.from, r.to).map((m) => renderSlotRow(m, undefined, false))}
                </>
              ) : (
                <GapRow label={gapLabel(r)} onClick={() => toggleGap(r.key)} />
              )}
            </Fragment>
          ))}
          {nowIdx === rows.length && rows.length > 0 && renderNowLine}
        </div>
      </div>
      {/* D.3：幫病人約 popover（ONLINE 格撳開 — 既有對話搜尋 → 發 Flow prefill） */}
      {pop && p && (
        <div className="rounded-xl border border-line bg-panel p-3 space-y-2.5" aria-label="幫病人約">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-t1">
              幫病人約 · {p.providerName} · {date} {pop.slot.start}–{pop.slot.end}
            </span>
            <button
              type="button"
              onClick={() => {
                setPop(null);
                setRaceConv(null);
                setPopErr(null);
              }}
              className="ml-auto text-[10px] text-t3 hover:text-t1 px-1.5 py-0.5 rounded hover:bg-panel-2"
            >
              ✕ 關閉
            </button>
          </div>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSelId(null);
              setRaceConv(null);
            }}
            placeholder="搜病人（姓名／電話）— 揀返既有對話"
            aria-label="搜病人"
            className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-panel-2 border border-line text-t1 placeholder:text-t3"
          />
          {searching && <div className="text-[10.5px] text-t3">搜尋中…</div>}
          {searchErr && <div className="text-xs text-danger-text">{searchErr}</div>}
          {!searching && hits && hits.length === 0 && (
            <div className="text-[10.5px] text-t3">搵唔到病人（該店要有既有對話先約得）</div>
          )}
          {hits && hits.length > 0 && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {hits.map((h) => {
                const conv = convs?.find((c) => c.contactId === h.id) ?? null;
                const name = h.profileName || h.waId || "病人";
                return conv ? (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => {
                      setSelId(conv.id);
                      setRaceConv(null);
                      setPopErr(null);
                    }}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg border text-xs flex items-center gap-2 ${
                      selId === conv.id ? "bg-brand-soft border-brand text-t1" : "bg-panel-2 border-line text-t2 hover:bg-panel-2/70"
                    }`}
                  >
                    <span className="font-medium truncate">{name}</span>
                    {conv.assigneeName && <span className="text-[10px] text-t3">負責：{conv.assigneeName}</span>}
                    <span className={`ml-auto text-[10px] ${conv.window.open ? "text-ok-text" : "text-warn-text"}`}>
                      {conv.window.open ? "窗口開緊" : "窗口已過"}
                    </span>
                  </button>
                ) : (
                  <div key={h.id} className="px-2.5 py-1.5 rounded-lg bg-panel-2/50 text-xs text-t3 flex items-center gap-2">
                    <span className="truncate">{name}</span>
                    <span className="ml-auto text-[10px]">未開始對話</span>
                  </div>
                );
              })}
            </div>
          )}
          {convs === null && pop && !q.trim() && <div className="text-[10.5px] text-t3">載入既有對話…</div>}
          {popErr && <div className="text-xs text-danger-text">{popErr}</div>}
          {selConv ? (
            <div className="space-y-2">
              {raceConv || !selConv.window.open ? (
                <>
                  <div className="text-[10.5px] text-t3">呢位病人 24 小時窗口已過 — Flow 出唔到，改出三出路：</div>
                  <WindowExits conversation={raceConv ?? selConv} myStaffId={myStaffId} />
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void sendFlow(selConv)}
                  disabled={sending}
                  className="w-full text-xs px-3 py-2 rounded-lg bg-brand hover:bg-brand-hover text-panel font-semibold disabled:opacity-40"
                >
                  {sending ? "發送中…" : "發預約連結（Flow · 已鎖定呢格）"}
                </button>
              )}
              {/* G-3：人手落單（同 Flow 並存 — 直接入 Apricot；窗口唔阻落單本身，只影響自動確認訊息） */}
              {selConv.pinnedPatientApricotId ? (
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => void sendManual(selConv)}
                    disabled={manualBusy}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-line bg-panel-2 hover:bg-panel text-t1 font-medium disabled:opacity-40"
                    title="直接喺 Apricot 落單（15 分鐘），病人唔使行 Flow；成功後側欄出 CONFIRMED 卡"
                  >
                    {manualBusy ? "落單中…" : "人手落單（直接入 Apricot）"}
                  </button>
                  {!selConv.window.open && (
                    <div className="text-[10px] text-warn-text">窗口已過 — 落單照行，但確認訊息要用 template 手發</div>
                  )}
                </div>
              ) : (
                <div className="text-[10.5px] text-t3">人手落單要先喺側欄釘住舊客（新客代落單唔開放）。</div>
              )}
            </div>
          ) : (
            <div className="text-[10.5px] text-t3">揀一個既有對話，先可以發預約連結／人手落單（唔會重複開對話）。</div>
          )}
        </div>
      )}
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
