"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";

/**
 * hub 第二 tab「主動跟進」（MD §5.4 — cwi-followup-p4 S6 → ★ cwi-followup-v3-20260916）。
 *
 * ★ v3（員工提示層）形態：系統只指出邊個對話要跟＋點解；發唔發一律員工撳。
 * 三步：① 幾時排（trigger 規則列表 + 上輪 scan 健康）② 取消條件（五項，opt-out 鐵律鎖定）③ 點發（cron 零 outbound — 對話內建議卡）。
 * 健康警示 6 項：template 未審批 / 建議積壓 > 30 / opt-out 詞未設 / 索引 job 昨晚失敗 / 電話正規化率 < 90% / A-1 依賴斷線 3 連 DEP_FAIL。
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
  maxSends: number;
  enabled: boolean;
  // ★ v3：A-1 掃描留痕（OK | DEP_FAIL | EMPTY）
  lastScanAt: string | null;
  lastScanResult: string | null;
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
  sendPolicy: { note: string };
  health: Warning[];
  queue: { suggested: number };
  generatedAt: string;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("zh-HK", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
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
      {/* 健康警示（hub §4 延伸 — 6 項，含 A-1 依賴斷線） */}
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
        待跟進建議（SUGGESTED，等員工喺對話內建議卡處理）：{data.queue.suggested} 條
      </div>

      {/* ① 幾時排 — trigger 規則列表 */}
      <section className="bg-panel border border-line rounded-2xl p-4" data-e2e="fhub-step1">
        <h2 className="text-[14px] font-semibold text-t1 mb-1">① 幾時排 — 跟進規則（{data.rules.length} 條）</h2>
        <p className="text-[11px] text-t3 mb-3">
          出廠 6 條（P3 對話/預約 3 + P4 臨床 3；F 欠款類已剷）；規則管理喺「跟進規則」後台。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-t3 border-b border-line">
                <th className="py-1.5 pr-3 font-medium">規則</th>
                <th className="py-1.5 pr-3 font-medium">觸發時機</th>
                <th className="py-1.5 pr-3 font-medium">適用治療（visit type）</th>
                <th className="py-1.5 pr-3 font-medium">上輪 scan</th>
                <th className="py-1.5 font-medium">狀態</th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0" data-e2e={`fhub-rule-${r.trigger}`}>
                  <td className="py-2 pr-3 text-t1 whitespace-nowrap font-medium">{r.name}</td>
                  <td className="py-2 pr-3 text-t2 whitespace-nowrap">{r.whenText}</td>
                  <td className="py-2 pr-3 text-t2">{r.reasonLabels.length ? r.reasonLabels.join("、") : "—"}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {r.lastScanAt ? (
                      <>
                        <div className="text-t3 text-[11px]">{fmtTs(r.lastScanAt)}</div>
                        <div
                          className={
                            r.lastScanResult === "DEP_FAIL"
                              ? "text-danger-text font-semibold"
                              : r.lastScanResult === "EMPTY"
                                ? "text-t3"
                                : "text-ok-text"
                          }
                          data-e2e={`fhub-rule-scan-${r.trigger}`}
                        >
                          {r.lastScanResult ?? "—"}
                        </div>
                      </>
                    ) : (
                      <span className="text-t3">—</span>
                    )}
                  </td>
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

      {/* ② 取消條件 — 五項 checkbox（opt-out 鎖定；F 類 PAID 已隨欠款整類剷走） */}
      <section className="bg-panel border border-line rounded-2xl p-4" data-e2e="fhub-step2">
        <h2 className="text-[14px] font-semibold text-t1 mb-1">② 取消條件（每次發送前重跑）</h2>
        <p className="text-[11px] text-t3 mb-3">五項全部常開；OPT_OUT 鐵律鎖定 — 任何規則唔可覆蓋。</p>
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

      {/* ③ 點發 — v3：cron 零 outbound，一律對話內建議卡（員工撳） */}
      <section className="bg-panel border border-line rounded-2xl p-4" data-e2e="fhub-step3">
        <h2 className="text-[14px] font-semibold text-t1 mb-1">③ 點發</h2>
        <div className="text-[12.5px] text-t2 mb-3" data-e2e="fhub-send-policy">
          {data.sendPolicy.note}
        </div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-t3 border-b border-line">
              <th className="py-1.5 pr-3 font-medium">規則</th>
              <th className="py-1.5 font-medium">Template（過窗發送用）</th>
            </tr>
          </thead>
          <tbody>
            {data.rules.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="py-2 pr-3 text-t1 whitespace-nowrap">{r.name}</td>
                <td className="py-2 text-t2">
                  {r.templateName}
                  {r.templateApproved === false && <span className="text-warn-text">（未審批 — 過窗發唔出，窗口內 free-form 不受影響）</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
