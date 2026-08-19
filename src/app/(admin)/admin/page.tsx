import { getAiStatusSnapshot } from "@/lib/ai/status";
import prisma from "@/lib/prisma";
import { getServerSession } from "@/lib/session-server";
import { AlertsPanel, type AlertItem } from "./alerts-panel";
import { TotpCard } from "./totp-card";

/**
 * /admin — 總覽 + AI 狀態卡（Phase 2）。
 * ADMIN-only 由 layout 把關（未登入 → /login；STAFF → /inbox）。
 * AI 狀態 = 真數據（mode/model/breaker/probe/call 統計）— healthz 同源。
 * Phase 2b：加最近一次 call 實測 latency/tokens + 各舖 AI 模式（DRAFT/AUTO）
 * 同近 24h 自動發數量/成功率。
 * Phase 4：加 警報（alerts）區塊 + 各號 quality_rating 健康表。
 * 安全審計 H-2：加 TOTP 兩步驟卡片（enroll QR/secret + 啟用狀態）。
 */
export const metadata = { title: "總覽 — WA Clinic Inbox" };

const QUALITY_CLS: Record<string, string> = {
  GREEN: "bg-ok-soft text-ok-text border-ok/40",
  YELLOW: "bg-warn-soft text-warn-text border-warn/40",
  RED: "bg-danger-soft text-danger-text border-danger/40",
};

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  const toneCls =
    tone === "ok"
      ? "text-ok-text"
      : tone === "warn"
        ? "text-warn-text"
        : tone === "bad"
          ? "text-danger-text font-medium"
          : "text-t1";
  return (
    <div className="flex justify-between py-1.5 text-sm border-b border-line last:border-0">
      <span className="text-t2">{label}</span>
      <span className={toneCls}>{value}</span>
    </div>
  );
}

export default async function AdminOverviewPage() {
  // 安全審計 H-2：本 ADMIN 嘅 TOTP 啟用狀態（layout 已把關 = 必然 ADMIN）
  const session = await getServerSession();
  const adminUser = session
    ? await prisma.staffUser.findUnique({
        where: { id: session.staffId },
        select: { totpSecretEnc: true },
      })
    : null;
  const totpEnabled = adminUser?.totpSecretEnc != null;

  const [ai, alerts, clinics] = await Promise.all([
    getAiStatusSnapshot(),
    prisma.alert.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.clinic.findMany({
      orderBy: { code: "asc" },
      select: {
        code: true,
        name: true,
        waDisplayNumber: true,
        qualityRating: true,
        qualityCheckedAt: true,
        lastWebhookEventAt: true,
      },
    }),
  ]);
  const alertItems: AlertItem[] = alerts.map((a) => ({
    id: a.id,
    type: a.type,
    severity: a.severity,
    clinicCode: a.clinicCode,
    detail: a.detail,
    createdAt: a.createdAt.toISOString(),
    resolvedAt: a.resolvedAt ? a.resolvedAt.toISOString() : null,
  }));

  const probeTone = ai.probe === "ok" ? "ok" : ai.probe === "degraded" ? "warn" : "bad";
  const degraded = ai.probe === "down" || ai.breaker.state === "open";
  const rate =
    ai.stats?.successRate === null || ai.stats === null
      ? null
      : Math.round(ai.stats.successRate * 100);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-t1">總覽</h1>
        <p className="text-sm text-t2 mt-1">
          AI triage 狀態（真數據）＋ 管理入口。AI 永遠本地 vLLM（D4）；斷線 = 降級，inbox 照常。
        </p>
      </div>

      {/* ── AI 狀態卡 ── */}
      <section className="bg-panel rounded-lg border border-line p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-t1">AI Triage 狀態</h2>
          {degraded ? (
            <span className="text-xs px-2 py-1 rounded bg-danger-soft text-danger-text border border-danger/40">
              ⚠ degraded — inbox 照常運作，AI 欄位顯示「—」
            </span>
          ) : ai.mode === "mock" ? (
            <span className="text-xs px-2 py-1 rounded bg-warn-soft text-warn-text border border-warn/40">
              mock mode（無 GPU）
            </span>
          ) : (
            <span className="text-xs px-2 py-1 rounded bg-ok-soft text-ok-text border border-ok/40">
              normal
            </span>
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-x-8">
          <div>
            <Row label="模式" value={ai.mode === "mock" ? "mock（AI_MOCK=1）" : "real（vLLM）"} tone={ai.mode === "mock" ? "warn" : "ok"} />
            <Row label="Primary model" value={ai.primaryModel} />
            <Row label="Fallback model" value={ai.fallbackModel} />
            <Row label="Endpoint" value={ai.baseUrlConfigured ? "已設定" : "未設定"} tone={ai.baseUrlConfigured ? undefined : "bad"} />
            <Row label="Health probe" value={ai.probe} tone={probeTone} />
          </div>
          <div>
            <Row
              label="Circuit breaker"
              value={ai.breaker.state === "open" ? `OPEN（${Math.max(0, Math.round(((ai.breaker.openUntilMs ?? 0) - Date.now()) / 1000))}s）` : "closed"}
              tone={ai.breaker.state === "open" ? "bad" : undefined}
            />
            <Row
              label="Call 成功率"
              value={rate === null ? "—" : `${rate}%（${ai.stats!.okCalls}/${ai.stats!.totalCalls}）`}
              tone={rate === null ? undefined : rate >= 90 ? "ok" : rate >= 70 ? "warn" : "bad"}
            />
            <Row
              label="最近 latency"
              value={ai.stats?.lastLatencyMs !== null && ai.stats?.lastLatencyMs !== undefined ? `${ai.stats.lastLatencyMs}ms` : "—"}
            />
            <Row
              label="最近 tokens"
              value={ai.stats?.lastTokens !== null && ai.stats?.lastTokens !== undefined ? String(ai.stats.lastTokens) : "—"}
            />
            <Row label="最近成功" value={ai.stats?.lastOkAt ? new Date(ai.stats.lastOkAt).toLocaleString("zh-HK") : "—"} />
            <Row
              label="最近錯誤"
              value={ai.stats?.lastError ?? "—"}
              tone={ai.stats?.lastError ? "warn" : undefined}
            />
          </div>
        </div>

        {ai.mockFail && (
          <p className="mt-3 text-xs text-danger-text">
            ⚠ AI_MOCK_FAIL=1 生效中 — mock 模擬 AI 斷線（E2E T16 用；上線前必須移除）。
          </p>
        )}
      </section>

      {/* ── 各舖 AI 模式（Phase 2b：DRAFT/AUTO + 近 24h 自動發統計） ── */}
      <section className="bg-panel rounded-lg border border-line p-5">
        <h2 className="font-medium text-t1 mb-3">各舖 AI 模式（近 24h）</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-t2 border-b border-line">
            <tr>
              <th className="py-2 font-medium">店舖</th>
              <th className="py-2 font-medium">模式</th>
              <th className="py-2 font-medium">24h 自動發</th>
              <th className="py-2 font-medium">成功率</th>
            </tr>
          </thead>
          <tbody>
            {ai.clinics.map((c) => {
              const rate24 =
                c.successRate24h === null ? null : Math.round(c.successRate24h * 100);
              return (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td className="py-2">
                    {c.code}
                    <span className="text-t3 ml-2 text-xs">{c.name}</span>
                  </td>
                  <td className="py-2">
                    {c.aiMode === "AUTO" ? (
                      <span className="inline-flex items-center rounded-full bg-warn-soft border border-warn/40 px-2 py-0.5 text-xs font-semibold text-warn-text">
                        ⚡ AUTO — AI 直接覆病人
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-panel-2 border border-line-strong px-2 py-0.5 text-xs text-t2">
                        ✏️ DRAFT（預設）
                      </span>
                    )}
                  </td>
                  <td className="py-2">{c.autoSent24h === 0 ? "—" : `${c.autoSentOk24h}/${c.autoSent24h} 則`}</td>
                  <td className="py-2">
                    {rate24 === null ? (
                      "—"
                    ) : (
                      <span className={rate24 >= 90 ? "text-ok-text" : rate24 >= 70 ? "text-warn-text" : "text-danger-text"}>
                        {rate24}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-t2">
          AUTO 鐵律：URGENT_PAIN / HIGH / needsHuman / 超出 24h 窗口 永遠唔自動發（退回 staff 處理）；
          切換見「診所」頁。
        </p>
      </section>

      {/* ── Phase 4：警報（未解決；health-check 每 5 分鐘 / quality-check 每日） ── */}
      <section className="bg-panel rounded-lg border border-line p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-t1">警報（未解決）</h2>
          <span className="text-xs text-t2">health-check 每 5 分鐘 · quality-check 每日 · 恢復自動 resolve</span>
        </div>
        <AlertsPanel alerts={alertItems} />
      </section>

      {/* ── Phase 4：各號 quality_rating（被 ban 前哨指標 — MD §9.3） ── */}
      <section className="bg-panel rounded-lg border border-line p-5">
        <h2 className="font-medium text-t1 mb-3">WhatsApp 號健康（quality_rating）</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-t2 border-b border-line">
            <tr>
              <th className="py-2 font-medium">店舖</th>
              <th className="py-2 font-medium">號</th>
              <th className="py-2 font-medium">quality_rating</th>
              <th className="py-2 font-medium">上次檢查</th>
              <th className="py-2 font-medium">最後 webhook 事件</th>
            </tr>
          </thead>
          <tbody>
            {clinics.map((c) => (
              <tr key={c.code} className="border-b border-line last:border-0">
                <td className="py-2">
                  {c.code}
                  <span className="text-t3 ml-2 text-xs">{c.name}</span>
                </td>
                <td className="py-2 font-mono text-t2">{c.waDisplayNumber ?? "—"}</td>
                <td className="py-2">
                  {c.qualityRating ? (
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${QUALITY_CLS[c.qualityRating] ?? "bg-panel-2 text-t2 border-line-strong"}`}>
                      {c.qualityRating}
                    </span>
                  ) : (
                    <span className="text-xs text-t3">未檢查</span>
                  )}
                </td>
                <td className="py-2 text-t2">
                  {c.qualityCheckedAt ? new Date(c.qualityCheckedAt).toLocaleString("zh-HK") : "—"}
                </td>
                <td className="py-2 text-t2">
                  {c.lastWebhookEventAt ? new Date(c.lastWebhookEventAt).toLocaleString("zh-HK") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-t2">
          YELLOW/RED = 被 ban 前哨（每日 06:30 自動拉；跌落即 HIGH alert + 通知）。
        </p>
      </section>

      {/* ── 安全審計 H-2：TOTP 兩步驟（最小卡片） ── */}
      <TotpCard enabled={totpEnabled} />

      {/* ── 管理入口 ── */}
      <section className="grid grid-cols-2 gap-4">
        <a
          href="/admin/clinics"
          className="bg-panel rounded-lg border border-line p-4 hover:border-brand transition-colors"
        >
          <div className="font-medium text-t1">診所</div>
          <div className="text-sm text-t2 mt-1">店舖 / WhatsApp 號碼 / greeting 配置</div>
        </a>
        <a
          href="/admin/staff"
          className="bg-panel rounded-lg border border-line p-4 hover:border-brand transition-colors"
        >
          <div className="font-medium text-t1">員工</div>
          <div className="text-sm text-t2 mt-1">帳號 / 角色（ADMIN / STAFF）</div>
        </a>
        <a
          href="/ops"
          className="bg-panel rounded-lg border border-line p-4 hover:border-brand transition-colors"
        >
          <div className="font-medium text-t1">營運週報</div>
          <div className="text-sm text-t2 mt-1">最近 8 週趨勢 + 本期指標（FRT / 採用率 / 轉化率）</div>
        </a>
      </section>
    </div>
  );
}
