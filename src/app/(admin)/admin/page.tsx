import { getAiStatusSnapshot } from "@/lib/ai/status";

/**
 * /admin — 總覽 + AI 狀態卡（Phase 2）。
 * ADMIN-only 由 layout 把關（未登入 → /login；STAFF → /inbox）。
 * AI 狀態 = 真數據（mode/model/breaker/probe/call 統計）— healthz 同源。
 */
export const metadata = { title: "總覽 — WA Clinic Inbox" };

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  const toneCls =
    tone === "ok"
      ? "text-green-700"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad"
          ? "text-red-600 font-medium"
          : "text-neutral-900";
  return (
    <div className="flex justify-between py-1.5 text-sm border-b border-neutral-100 last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className={toneCls}>{value}</span>
    </div>
  );
}

export default async function AdminOverviewPage() {
  const ai = await getAiStatusSnapshot();

  const probeTone = ai.probe === "ok" ? "ok" : ai.probe === "degraded" ? "warn" : "bad";
  const degraded = ai.probe === "down" || ai.breaker.state === "open";
  const rate =
    ai.stats?.successRate === null || ai.stats === null
      ? null
      : Math.round(ai.stats.successRate * 100);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-neutral-900">總覽</h1>
        <p className="text-sm text-neutral-500 mt-1">
          AI triage 狀態（真數據）＋ 管理入口。AI 永遠本地 vLLM（D4）；斷線 = 降級，inbox 照常。
        </p>
      </div>

      {/* ── AI 狀態卡 ── */}
      <section className="bg-white rounded-lg border border-neutral-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-neutral-900">AI Triage 狀態</h2>
          {degraded ? (
            <span className="text-xs px-2 py-1 rounded bg-red-50 text-red-700 border border-red-200">
              ⚠ degraded — inbox 照常運作，AI 欄位顯示「—」
            </span>
          ) : ai.mode === "mock" ? (
            <span className="text-xs px-2 py-1 rounded bg-amber-50 text-amber-700 border border-amber-200">
              mock mode（無 GPU）
            </span>
          ) : (
            <span className="text-xs px-2 py-1 rounded bg-green-50 text-green-700 border border-green-200">
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
            <Row label="最近成功" value={ai.stats?.lastOkAt ? new Date(ai.stats.lastOkAt).toLocaleString("zh-HK") : "—"} />
            <Row
              label="最近錯誤"
              value={ai.stats?.lastError ?? "—"}
              tone={ai.stats?.lastError ? "warn" : undefined}
            />
          </div>
        </div>

        {ai.mockFail && (
          <p className="mt-3 text-xs text-red-600">
            ⚠ AI_MOCK_FAIL=1 生效中 — mock 模擬 AI 斷線（E2E T16 用；上線前必須移除）。
          </p>
        )}
      </section>

      {/* ── 管理入口 ── */}
      <section className="grid grid-cols-2 gap-4">
        <a
          href="/admin/clinics"
          className="bg-white rounded-lg border border-neutral-200 p-4 hover:border-blue-300 transition-colors"
        >
          <div className="font-medium text-neutral-900">診所</div>
          <div className="text-sm text-neutral-500 mt-1">店舖 / WhatsApp 號碼 / greeting 配置</div>
        </a>
        <a
          href="/admin/staff"
          className="bg-white rounded-lg border border-neutral-200 p-4 hover:border-blue-300 transition-colors"
        >
          <div className="font-medium text-neutral-900">員工</div>
          <div className="text-sm text-neutral-500 mt-1">帳號 / 角色（ADMIN / STAFF）</div>
        </a>
      </section>
    </div>
  );
}
