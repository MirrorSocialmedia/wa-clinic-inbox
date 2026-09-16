"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";

/**
 * hub 第二 tab「主動跟進」（MD §5.4 — cwi-followup-p4 S6）。
 * 三步：① 幾時排（trigger 規則列表）② 取消條件（六項 checkbox，opt-out 鐵律鎖定）③ 點發（template · L1/L2 · 每日上限）。
 * 健康警示 5 項：template 未審批 / 隊列積壓 > 30 / opt-out 詞未設 / 索引 job 昨晚失敗 / 電話正規化率 < 90%。
 * 零 client 端邏輯分支：全部數字 server 端（GET /api/admin/followup-hub）即時算。
 */
interface Rule {
  id: string;
  name: string;
  trigger: string;
  delayValue: number;
  delayUnit: string;
  whenText: string;
  reasonCodes: string[];
  reasonLabels: string[];
  templateKey: string;
  templateName: string;
  templateApproved: boolean | null;
  level: string;
  maxSends: number;
  enabled: boolean;
}
interface CancelCondition {
  key: string;
  label: string;
  locked: boolean;
  note: string;
}
interface Warning {
  id: string;
  ok: boolean;
  reason: string;
}
interface FollowupHub {
  rules: Rule[];
  cancelConditions: CancelCondition[];
  sendPolicy: { dailyCap: string; l1: string; l2: string };
  health: Warning[];
  queue: { due: number; scheduled: number };
  generatedAt: string;
}

export default function FollowupHubTab() {
  const [data, setData] = useState<FollowupHub | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/followup-hub", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as FollowupHub);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "載入失敗");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (loadErr) {
    return <div className="bg-danger-soft text-danger-text text-[13px] rounded-xl p-3" data-e2e="fhub-err">{loadErr}</div>;
  }
  if (!data) {
    return <div className="text-[13px] text-t3 py-8 text-center">載入中…</div>;
  }

  const bad = data.health.filter((h) => !h.ok);

  return (
    <div className="flex flex-col gap-4" data-e2e="fhub-root">
      {/* 健康警示（hub §4 延伸 — 5 項） */}
      {bad.length > 0 && (
        <div className="flex flex-wrap gap-2" role="alert" data-e2e="fhub-warnings">
          {bad.map((h) => (
            <span key={h.id} className="px-3 py-1.5 rounded-full bg-danger-soft text-danger-text text-[12px] font-semibold border border-danger/20" data-e2e={`fhub-warn-${h.id}`}>
              ⚠ {h.reason}
            </span>
          ))}
        </div>
      )}
      <div className="text-[11px] text-t3" data-e2e="fhub-queue">
        待跟進隊列：DUE {data.queue.due} · SCHEDULED {data.queue.scheduled}
      </div>

      {/* ① 幾時排 — trigger 規則列表 */}
      <section className="bg-panel border border-line rounded-2xl p-4" data-e2e="fhub-step1">
        <h2 className="text-[14px] font-semibold text-t1 mb-1">① 幾時排 — 跟進規則（{data.rules.length} 條）</h2>
        <p className="text-[11px] text-t3 mb-3">出廠 7 條（P3 對話/預約 4 + P4 臨床 3）；新規則喺「主動跟進」後台加。</p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-t3 border-b border-line">
                <th className="py-1.5 pr-3 font-medium">規則</th>
                <th className="py-1.5 pr-3 font-medium">觸發時機</th>
                <th className="py-1.5 pr-3 font-medium">適用治療（visit type）</th>
                <th className="py-1.5 pr-3 font-medium">狀態</th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0" data-e2e={`fhub-rule-${r.trigger}`}>
                  <td className="py-2 pr-3 text-t1 whitespace-nowrap font-medium">{r.name}</td>
                  <td className="py-2 pr-3 text-t2 whitespace-nowrap">{r.whenText}</td>
                  <td className="py-2 pr-3 text-t2">{r.reasonLabels.length ? r.reasonLabels.join("、") : "—"}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {!r.enabled ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-panel-2 text-t3">停用</span>
                    ) : r.templateApproved === false ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-warn-soft text-warn-text" data-e2e={`fhub-rule-unapproved-${r.trigger}`}>template 未審批</span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-ok-soft text-ok-text">啟用</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ② 取消條件 — 六項 checkbox（opt-out 鎖定） */}
      <section className="bg-panel border border-line rounded-2xl p-4" data-e2e="fhub-step2">
        <h2 className="text-[14px] font-semibold text-t1 mb-1">② 取消條件（每次發送前重跑）</h2>
        <p className="text-[11px] text-t3 mb-3">六項全部常開；OPT_OUT 鐵律鎖定 — 任何規則唔可覆蓋。</p>
        <div className="grid sm:grid-cols-2 gap-2">
          {data.cancelConditions.map((c) => (
            <div key={c.key} className="flex items-start gap-2 bg-panel-2/50 border border-line rounded-xl px-3 py-2" data-e2e={`fhub-cancel-${c.key}`}>
              <input type="checkbox" checked readOnly className="mt-0.5 accent-brand" aria-label={c.label} />
              <div className="min-w-0">
                <div className="text-[12.5px] text-t1 flex items-center gap-1.5">
                  {c.label}
                  {c.locked && <Lock size={11} className="text-t3" />}
                </div>
                <div className="text-[11px] text-t3">{c.note}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ③ 點發 — template 對應 · L1/L2 · 每日上限 */}
      <section className="bg-panel border border-line rounded-2xl p-4" data-e2e="fhub-step3">
        <h2 className="text-[14px] font-semibold text-t1 mb-1">③ 點發</h2>
        <div className="text-[12.5px] text-t2 space-y-1 mb-3">
          <div><span className="text-t3">L1：</span>{data.sendPolicy.l1}</div>
          <div><span className="text-t3">L2：</span>{data.sendPolicy.l2}</div>
          <div><span className="text-t3">每日上限：</span>{data.sendPolicy.dailyCap}</div>
        </div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-t3 border-b border-line">
              <th className="py-1.5 pr-3 font-medium">規則</th>
              <th className="py-1.5 pr-3 font-medium">Template</th>
              <th className="py-1.5 pr-3 font-medium">級別</th>
              <th className="py-1.5 font-medium">最多發</th>
            </tr>
          </thead>
          <tbody>
            {data.rules.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="py-2 pr-3 text-t1 whitespace-nowrap">{r.name}</td>
                <td className="py-2 pr-3 text-t2">
                  {r.templateName}
                  {r.templateApproved === false && <span className="text-warn-text">（未審批）</span>}
                </td>
                <td className="py-2 pr-3 text-t2 whitespace-nowrap">{r.level}</td>
                <td className="py-2 text-t2">{r.maxSends} 次</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
