import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { getServerSession } from "@/lib/session-server";

/**
 * /ops — 營運週報（Phase 4，MD §9.3）。Organic 版（2026-08-29 cwi-uiredesign P4，設計稿 1h）：
 * 四格 KPI + 8 週草稿採用率堆疊柱（深 = SENT_AS_IS 原文照發 / 淺 = SENT_EDITED 改過再發）。
 *
 * Scope（fail-closed）：
 * - STAFF → 自己店嘅週報（clinicId = 本店）
 * - ADMIN → 全部店（clinicId = ""，含逐店 breakdown）
 *
 * 內容：最新一期 KPI + 8 週趨勢柱 + 最新一期完整報表（text）。
 * 數據源 = OpsReport 表（每星期一 07:00 cron 自動生成；`pnpm weekly-report` 可手動補跑）。
 *
 * 注意（同任務書 /admin/ops 命名偏差）：/admin layout 係 ADMIN-only（STAFF 302→/inbox），
 * 為滿足「staff 本店 scope 可見」放喺 /ops — 見 README Phase 4「同 MD 唔同」。
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "營運週報 — WA Clinic Inbox" };

interface TrendRow {
  periodStart: string; // YYYY-MM-DD（週一）
  sentAsIs: number;
  sentEdited: number;
  rate: number | null;
}

/** OpsReport.metrics（JSONB）— 只讀用，最小結構定義（同 lib/ops/report.ts PeriodMetrics 對齊） */
interface MetricsShape {
  messages?: { total?: number };
  frt?: { answered?: number; totalInbound?: number; medianSec?: number };
  draftAdoption?: { sentAsIs?: number; sentEdited?: number; total?: number; rate?: number };
  flowCompletion?: { completed?: number; sent?: number; rate?: number };
  booking?: { confirmed?: number; total?: number; rate?: number; medianHandleMin?: number };
}

function pct(x: number | null): string {
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`;
}

function minHm(sec: number | null): string {
  if (sec === null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${s > 0 ? ` ${s}s` : ""}` : `${s}s`;
}

/** "YYYY-MM-DD" → "M/D"（柱下週次標籤） */
function md(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default async function OpsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // scope：STAFF 本店 / ADMIN 全部（"" sentinel）
  const scopeClinicId = session.role === "STAFF" ? session.clinicId! : "";
  const clinicCode =
    scopeClinicId === ""
      ? "ALL"
      : (await prisma.clinic.findUnique({ where: { id: scopeClinicId }, select: { code: true } }))?.code ?? "?";

  const reports = await prisma.opsReport.findMany({
    where: { clinicId: scopeClinicId },
    orderBy: { periodStart: "desc" },
    take: 8,
  });

  const trend: TrendRow[] = reports
    .map((r) => {
      const m = r.metrics as unknown as MetricsShape;
      return {
        periodStart: r.periodStart.toISOString().slice(0, 10),
        sentAsIs: m?.draftAdoption?.sentAsIs ?? 0,
        sentEdited: m?.draftAdoption?.sentEdited ?? 0,
        rate: m?.draftAdoption?.rate ?? null,
      };
    })
    .reverse(); // 舊 → 新（由左到右）

  const latest = reports[0] ?? null;
  const prev = reports[1] ?? null;
  const lm = latest ? (latest.metrics as unknown as MetricsShape) : null;
  const pm = prev ? (prev.metrics as unknown as MetricsShape) : null;

  // KPI 對上週變化（真數據先算；無上期 = 唔顯示）
  const msgDelta =
    lm?.messages?.total != null && pm?.messages?.total ? ((lm.messages.total - pm.messages.total!) / pm.messages.total!) * 100 : null;
  const frtDeltaSec =
    lm?.frt?.medianSec != null && pm?.frt?.medianSec != null ? lm.frt.medianSec - pm.frt.medianSec : null;

  const maxDrafts = Math.max(1, ...trend.map((t) => t.sentAsIs + t.sentEdited));
  const latestPeriodLabel = latest
    ? `${latest.periodStart.toISOString().slice(0, 10)} → ${latest.periodEnd.toISOString().slice(0, 10)}`
    : null;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="bg-panel border-b border-line">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-t1">WA Clinic Inbox</span>
            <nav className="flex gap-4 text-sm">
              <a href="/inbox" className="text-t2 hover:text-t1">
                Inbox
              </a>
              {session.role === "ADMIN" && (
                <a href="/admin" className="text-t2 hover:text-t1">
                  總覽
                </a>
              )}
              <span className="text-brand-text font-medium">營運週報</span>
            </nav>
          </div>
          <span className="text-xs text-t3">
            {session.name}（{session.role} · scope={clinicCode}）
          </span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* 頁頭 */}
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-[25px] text-t1">營運週報</h1>
            <p className="text-[12.5px] text-t2 mt-1">
              {latestPeriodLabel ?? "暫無週報"} · scope={clinicCode} — 每星期一 07:00 自動生成上一週報表（OpsReport 表 + ALERT_CHANNEL 推送）。
            </p>
          </div>
          <span className="inline-flex items-center rounded-full bg-panel-2 border border-line px-3 py-1 text-[11.5px] font-semibold text-t2 flex-none">
            {scopeClinicId === "" ? "全部店" : `本店 ${clinicCode}`}
          </span>
        </div>

        {/* KPI 四格（最新一期） */}
        {latest && lm ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            <div className="bg-panel-2 rounded-[22px] p-4">
              <div className="text-[10px] uppercase tracking-[0.1em] text-t2">訊息量</div>
              <div className="font-display text-[26px] leading-none text-t1 mt-1.5">
                {(lm.messages?.total ?? 0).toLocaleString()}
              </div>
              <div className={`text-[11px] mt-1 ${msgDelta == null ? "text-t3" : msgDelta >= 0 ? "text-brand-text" : "text-danger-text"}`}>
                {msgDelta == null ? "（無上期對照）" : `${msgDelta >= 0 ? "↑" : "↓"} ${Math.abs(msgDelta).toFixed(0)}% 對上週`}
              </div>
            </div>
            <div className="bg-panel-2 rounded-[22px] p-4">
              <div className="text-[10px] uppercase tracking-[0.1em] text-t2">FRT 中位數</div>
              <div className="font-display text-[26px] leading-none text-t1 mt-1.5">{minHm(lm.frt?.medianSec ?? null)}</div>
              <div className={`text-[11px] mt-1 ${frtDeltaSec == null ? "text-t3" : frtDeltaSec <= 0 ? "text-brand-text" : "text-danger-text"}`}>
                {frtDeltaSec == null
                  ? `已覆 ${lm.frt?.answered ?? 0} / ${lm.frt?.totalInbound ?? 0}（未覆唔計）`
                  : `${frtDeltaSec <= 0 ? "↓" : "↑"} ${minHm(Math.abs(frtDeltaSec))} 對上週（未覆唔計）`}
              </div>
            </div>
            <div className="bg-panel-2 rounded-[22px] p-4">
              <div className="text-[10px] uppercase tracking-[0.1em] text-t2">Flow 完成率</div>
              <div className="font-display text-[26px] leading-none text-t1 mt-1.5">{pct(lm.flowCompletion?.rate ?? null)}</div>
              <div className="text-[11px] text-t3 mt-1">
                {lm.flowCompletion?.completed ?? 0} 完成 / {lm.flowCompletion?.sent ?? 0} 發出
              </div>
            </div>
            <div className="bg-panel-2 rounded-[22px] p-4">
              <div className="text-[10px] uppercase tracking-[0.1em] text-t2">預約卡 → 確認</div>
              <div className="font-display text-[26px] leading-none text-t1 mt-1.5">{pct(lm.booking?.rate ?? null)}</div>
              <div className="text-[11px] text-t3 mt-1">
                {lm.booking?.medianHandleMin != null ? `中位處理 ${lm.booking.medianHandleMin} 分鐘` : `${lm.booking?.confirmed ?? 0} / ${lm.booking?.total ?? 0} 張確認`}
              </div>
            </div>
          </div>
        ) : null}

        {/* 8 週草稿採用率 — 堆疊柱（深 = 原文照發 / 淺 = 改過再發） */}
        <section className="bg-panel rounded-[26px] border border-line p-6">
          <h2 className="text-[16px] text-t1">草稿採用率 · 最近 {trend.length} 週</h2>
          <p className="text-[11px] text-t2 mt-0.5 mb-4">深色＝原文照發，淺色＝改過再發。分母是所有草稿，含棄用。</p>
          {trend.length === 0 ? (
            <p className="text-sm text-t2">暫無數據。</p>
          ) : (
            <div className="flex items-end gap-3 h-[150px] pb-[22px] relative">
              {trend.map((t, i) => {
                const total = t.sentAsIs + t.sentEdited;
                const isLatest = i === trend.length - 1;
                return (
                  <div key={t.periodStart} className="flex-1 flex flex-col justify-end gap-[2px] h-full relative">
                    {/* 上段 = 改過再發（淺） */}
                    <div
                      className={`w-full ${t.sentEdited > 0 ? (isLatest ? "bg-ok-soft" : "bg-brand-soft") : ""} rounded-t-lg`}
                      style={{ height: t.sentEdited > 0 ? `${(t.sentEdited / maxDrafts) * 100}%` : undefined }}
                    />
                    {/* 下段 = 原文照發（深） */}
                    <div
                      className={`w-full ${total > 0 ? "bg-brand-hover" : "bg-line"} ${total > 0 ? "rounded-b-lg" : "rounded"}`}
                      style={{ height: total > 0 ? `${(t.sentAsIs / maxDrafts) * 100}%` : "4px" }}
                    />
                    <span
                      className={`absolute bottom-0 left-1/2 -translate-x-1/2 text-[10px] ${
                        isLatest ? "font-semibold text-brand-text" : "text-t3"
                      } whitespace-nowrap`}
                    >
                      {isLatest ? `本週 ${pct(t.rate)}` : md(t.periodStart)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-4 text-xs text-t2">
            FRT = 首次回覆時間（病人 inbound → 該對話第一條 staff/AUTO outbound，秒；unanswered 唔計入中位數）。
            草稿採用率 = (SENT_AS_IS+SENT_EDITED)/全部 draft。Flow 完成率 = COMPLETED/SENT。
            預約→確認 = CONFIRMED/全部 BookingRequest。
          </p>
        </section>

        {/* 最新一期完整報表 */}
        {latest ? (
          <section className="bg-panel rounded-[26px] border border-line p-6">
            <h2 className="text-[16px] text-t1 mb-3">
              最新一期完整報表（{latest.periodStart.toISOString().slice(0, 10)} → {latest.periodEnd.toISOString().slice(0, 10)}）
            </h2>
            <pre className="text-sm text-t1 whitespace-pre-wrap font-mono bg-panel-2 border border-line rounded-[18px] p-4">
              {latest.text}
            </pre>
          </section>
        ) : (
          <section className="bg-panel rounded-[26px] border border-line p-6 text-sm text-t2">
            仲未有週報 — 每星期一 07:00 自動生成；可手動補跑：
            <code className="ml-1 text-xs bg-panel-2 px-1.5 py-0.5 rounded-full">pnpm weekly-report</code>
          </section>
        )}
      </main>
    </div>
  );
}
