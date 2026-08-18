import { getAiStatusSnapshot } from "@/lib/ai/status";

/**
 * /admin — 總覽 + AI 狀態卡（Phase 2）。
 * ADMIN-only 由 layout 把關（未登入 → /login；STAFF → /inbox）。
 * AI 狀態 = 真數據（mode/model/breaker/probe/call 統計）— healthz 同源。
 * Phase 2b：加最近一次 call 實測 latency/tokens + 各舖 AI 模式（DRAFT/AUTO）
 * 同近 24h 自動發數量/成功率。
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
          <p className="mt-3 text-xs text-red-600">
            ⚠ AI_MOCK_FAIL=1 生效中 — mock 模擬 AI 斷線（E2E T16 用；上線前必須移除）。
          </p>
        )}
      </section>

      {/* ── 各舖 AI 模式（Phase 2b：DRAFT/AUTO + 近 24h 自動發統計） ── */}
      <section className="bg-white rounded-lg border border-neutral-200 p-5">
        <h2 className="font-medium text-neutral-900 mb-3">各舖 AI 模式（近 24h）</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500 border-b border-neutral-200">
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
                <tr key={c.id} className="border-b border-neutral-100 last:border-0">
                  <td className="py-2">
                    {c.code}
                    <span className="text-neutral-400 ml-2 text-xs">{c.name}</span>
                  </td>
                  <td className="py-2">
                    {c.aiMode === "AUTO" ? (
                      <span className="inline-flex items-center rounded-full bg-amber-100 border border-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-900">
                        ⚡ AUTO — AI 直接覆病人
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-neutral-100 border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700">
                        ✏️ DRAFT（預設）
                      </span>
                    )}
                  </td>
                  <td className="py-2">{c.autoSent24h === 0 ? "—" : `${c.autoSentOk24h}/${c.autoSent24h} 則`}</td>
                  <td className="py-2">
                    {rate24 === null ? (
                      "—"
                    ) : (
                      <span className={rate24 >= 90 ? "text-green-700" : rate24 >= 70 ? "text-amber-600" : "text-red-600"}>
                        {rate24}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-neutral-500">
          AUTO 鐵律：URGENT_PAIN / HIGH / needsHuman / 超出 24h 窗口 永遠唔自動發（退回 staff 處理）；
          切換見「診所」頁。
        </p>
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
