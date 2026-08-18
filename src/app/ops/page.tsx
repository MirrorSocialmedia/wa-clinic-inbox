import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { getServerSession } from "@/lib/session-server";

/**
 * /ops — 營運週報（Phase 4，MD §9.3）。
 *
 * Scope（fail-closed）：
 * - STAFF → 自己店嘅週報（clinicId = 本店）
 * - ADMIN → 全部店（clinicId = ""，含逐店 breakdown）
 *
 * 內容：最近 8 週趨勢表 + 最新一期完整報表（text）。
 * 數據源 = OpsReport 表（每星期一 07:00 cron 自動生成；`pnpm weekly-report` 可手動補跑）。
 *
 * 注意（同任務書 /admin/ops 命名偏差）：/admin layout 係 ADMIN-only（STAFF 302→/inbox），
 * 為滿足「staff 本店 scope 可見」放喺 /ops — 見 README Phase 4「同 MD 唔同」。
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "營運週報 — WA Clinic Inbox" };

interface TrendRow {
  periodStart: string;
  messages: number;
  frtMedianSec: number | null;
  draftRate: number | null;
  flowRate: number | null;
  bookingRate: number | null;
}

/** OpsReport.metrics（JSONB）— 只讀用，最小結構定義（同 lib/ops/report.ts computeMetrics 輸出對齊） */
interface MetricsShape {
  messages?: { total?: number };
  frt?: { medianSec?: number };
  draftAdoption?: { rate?: number };
  flowCompletion?: { rate?: number };
  booking?: { rate?: number };
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
        messages: m?.messages?.total ?? 0,
        frtMedianSec: m?.frt?.medianSec ?? null,
        draftRate: m?.draftAdoption?.rate ?? null,
        flowRate: m?.flowCompletion?.rate ?? null,
        bookingRate: m?.booking?.rate ?? null,
      };
    })
    .reverse(); // 舊 → 新（趨勢由左到右）

  const latest = reports[0] ?? null;

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="bg-white border-b border-neutral-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-neutral-900">WA Clinic Inbox</span>
            <nav className="flex gap-4 text-sm">
              <a href="/inbox" className="text-neutral-600 hover:text-neutral-900">
                Inbox
              </a>
              {session.role === "ADMIN" && (
                <a href="/admin" className="text-neutral-600 hover:text-neutral-900">
                  總覽
                </a>
              )}
              <span className="text-blue-600 font-medium">營運週報</span>
            </nav>
          </div>
          <span className="text-xs text-neutral-500">
            {session.name}（{session.role} · scope={clinicCode}）
          </span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">營運週報</h1>
          <p className="text-sm text-neutral-500 mt-1">
            每星期一 07:00 自動生成上一週報表（OpsReport 表 + ALERT_CHANNEL 推送）。
            指標：訊息量 / FRT 中位數（inbound→首條 staff/AUTO outbound）/ 草稿採用率 / Flow 完成率 / 預約卡→確認轉化率。
          </p>
        </div>

        {/* 最新一期 */}
        {latest ? (
          <section className="bg-white rounded-lg border border-neutral-200 p-5">
            <h2 className="font-medium text-neutral-900 mb-3">
              最新一期（{latest.periodStart.toISOString().slice(0, 10)} → {latest.periodEnd.toISOString().slice(0, 10)}）
              <span className="text-xs text-neutral-400 ml-2">scope={clinicCode}</span>
            </h2>
            <pre className="text-sm text-neutral-800 whitespace-pre-wrap font-mono bg-neutral-50 border border-neutral-100 rounded p-4">
              {latest.text}
            </pre>
          </section>
        ) : (
          <section className="bg-white rounded-lg border border-neutral-200 p-5 text-sm text-neutral-500">
            仲未有週報 — 每星期一 07:00 自動生成；可手動補跑：
            <code className="ml-1 text-xs bg-neutral-100 px-1.5 py-0.5 rounded">pnpm weekly-report</code>
          </section>
        )}

        {/* 8 週趨勢 */}
        <section className="bg-white rounded-lg border border-neutral-200 p-5">
          <h2 className="font-medium text-neutral-900 mb-3">最近 {trend.length} 週趨勢</h2>
          {trend.length === 0 ? (
            <p className="text-sm text-neutral-500">暫無數據。</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500 border-b border-neutral-200">
                <tr>
                  <th className="py-2 font-medium">週（週一）</th>
                  <th className="py-2 font-medium">訊息量</th>
                  <th className="py-2 font-medium">FRT 中位數</th>
                  <th className="py-2 font-medium">草稿採用率</th>
                  <th className="py-2 font-medium">Flow 完成率</th>
                  <th className="py-2 font-medium">預約→確認</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((t) => (
                  <tr key={t.periodStart} className="border-b border-neutral-100 last:border-0">
                    <td className="py-2 font-mono text-neutral-700">{t.periodStart}</td>
                    <td className="py-2">{t.messages}</td>
                    <td className="py-2">{minHm(t.frtMedianSec)}</td>
                    <td className="py-2">{pct(t.draftRate)}</td>
                    <td className="py-2">{pct(t.flowRate)}</td>
                    <td className="py-2">{pct(t.bookingRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-neutral-500">
            FRT = 首次回覆時間（病人 inbound → 該對話第一條 staff/AUTO outbound，秒；unanswered 唔計入中位數）。
            草稿採用率 = (SENT_AS_IS+SENT_EDITED)/全部 draft。Flow 完成率 = COMPLETED/SENT。
            預約→確認 = CONFIRMED/全部 BookingRequest。
          </p>
        </section>
      </main>
    </div>
  );
}
