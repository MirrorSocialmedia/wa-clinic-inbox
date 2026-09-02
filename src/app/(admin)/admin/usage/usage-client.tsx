"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * /admin/usage client — cwi-window-20260901（P4 / W-4）
 *
 * 本月（按店 × 類別 × 人手/AI/系統）+ App 跟進次數（免費對照）+ 週趨勢 + AI 自動覆佔比
 * + 可選「每條 service 費率」粗略估算（純 client 端 — 唔硬編費率，Meta 香港費率會變）。
 * 尾部：§5 決策表 + W-5 安全線（員工指引同內容，寫喺度俾 ADMIN 複製去通告）。
 */

interface Row {
  clinicCode: string;
  category: string | null;
  staffSent: number;
  aiSent: number;
  systemSent: number;
  total: number;
}
interface Summary {
  month: string;
  rows: Row[];
  appHandoff: { clinicCode: string; count: number }[];
  weekTrend: { weekStart: string; current: boolean; total: number; aiAuto: number }[];
  totals: { staffSent: number; aiSent: number; systemSent: number; total: number; aiSharePct: number };
}

const CATEGORY_LABEL: Record<string, string> = {
  SERVICE: "service（窗口內自由回覆）",
  UTILITY: "utility template",
  MARKETING: "marketing",
  AUTH: "authentication",
  NONE: "none（唔計費）",
};
const categoryLabel = (c: string | null) => (c ? CATEGORY_LABEL[c] ?? c : "（legacy 未回填）");

export default function UsageClient() {
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rate, setRate] = useState(""); // 每條 service 費率（HKD）— 可選

  useEffect(() => {
    fetch("/api/admin/usage")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  const est = useMemo(() => {
    if (!data) return null;
    const r = Number.parseFloat(rate);
    if (!Number.isFinite(r) || r <= 0) return null;
    const serviceTotal = data.rows.filter((x) => x.category === "SERVICE").reduce((a, x) => a + x.total, 0);
    return { rate: r, serviceTotal, estHkd: Math.round(serviceTotal * r * 100) / 100 };
  }, [data, rate]);

  if (err) return <div className="p-4 text-sm text-danger">載入失敗：{err}</div>;
  if (!data) return <div className="p-4 text-sm text-t2">載入中…</div>;

  const clinics = Array.from(new Set(data.rows.map((r) => r.clinicCode))).sort();
  const maxWeek = Math.max(1, ...data.weekTrend.map((w) => w.total));

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto flex flex-col gap-6">
      {/* 本月按店 × 類別 */}
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-t1">本月（{data.month}）· 按店 × 類別</h2>
        {clinics.length === 0 ? (
          <div className="text-sm text-t2">本月零 outbound（API）。</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-t2 border-b border-line bg-panel-2">
                  <th className="px-3 py-2 font-medium">店</th>
                  <th className="px-3 py-2 font-medium">類別</th>
                  <th className="px-3 py-2 font-medium text-right">人手</th>
                  <th className="px-3 py-2 font-medium text-right">AI 自動</th>
                  <th className="px-3 py-2 font-medium text-right">系統</th>
                  <th className="px-3 py-2 font-medium text-right">合計</th>
                </tr>
              </thead>
              <tbody>
                {clinics.map((c) => (
                  <ClinicRows key={c} clinic={c} rows={data.rows.filter((r) => r.clinicCode === c)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="text-[11px] text-t3">
          只計經 WhatsApp API 出街嘅訊息（channel=API）；App echo / 內部備註唔計費、唔入呢張表。
        </div>
      </section>

      {/* App 跟進對照 + 佔比 */}
      <section className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-line bg-panel p-3 flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold text-t1">App 跟進（wa.me 撳掣次數）</h3>
          {data.appHandoff.length === 0 ? (
            <div className="text-sm text-t2">本月 0 次</div>
          ) : (
            data.appHandoff.map((h) => (
              <div key={h.clinicCode} className="text-sm text-t1">
                {h.clinicCode}：<span className="font-semibold">{h.count} 次</span>
                <span className="text-t3">（免費 — 做對照）</span>
              </div>
            ))
          )}
        </div>
        <div className="rounded-xl border border-line bg-panel p-3 flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold text-t1">AI 自動覆佔比</h3>
          <div className="text-sm text-t1">
            本月 API 出街 {data.totals.total} 條，其中 AI 自動 {data.totals.aiSent} 條 —{" "}
            <span className="font-semibold">{data.totals.aiSharePct}%</span>
          </div>
          <div className="h-2 rounded-full bg-panel-2 overflow-hidden">
            <div
              className="h-full bg-brand"
              style={{ width: `${Math.min(100, data.totals.aiSharePct)}%` }}
            />
          </div>
        </div>
      </section>

      {/* 週趨勢 */}
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-t1">週趨勢（最近 5 週 · API 出街條數）</h2>
        <div className="flex items-end gap-3 h-28 rounded-xl border border-line bg-panel p-3">
          {data.weekTrend.map((w) => (
            <div key={w.weekStart} className="flex-1 flex flex-col items-center gap-1" title={`${w.weekStart}：${w.total} 條（AI ${w.aiAuto}）`}>
              <div className="text-[10px] text-t2">{w.total}</div>
              <div
                className={`w-full max-w-10 rounded-t ${w.current ? "bg-warn" : "bg-brand"} opacity-80`}
                style={{ height: `${Math.max(4, (w.total / maxWeek) * 72)}px` }}
              />
              <div className="text-[10px] text-t3">
                {w.weekStart.slice(5)}
                {w.current ? "（本週）" : ""}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 粗略估算（唔硬編費率） */}
      <section className="rounded-xl border border-line bg-panel p-3 flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-t1">粗略估算（可選 — 唔硬編費率）</h3>
        <label className="text-[11.5px] text-t2 flex items-center gap-2">
          每條 service 費率（HKD）
          <input
            type="number"
            min="0"
            step="0.01"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="例 0.25"
            className="w-28 text-sm px-2 py-1 rounded-lg bg-panel-2 border border-line-strong text-t1"
          />
        </label>
        {est ? (
          <div className="text-sm text-t1">
            本月 service {est.serviceTotal} 條 × HK${est.rate.toFixed(2)} ≈{" "}
            <span className="font-semibold">HK${est.estHkd.toFixed(2)}</span>
            <span className="text-t3">（utility / marketing / auth 費率唔同 — 只係 service 粗略估算）</span>
          </div>
        ) : (
          <div className="text-[11px] text-t3">留空 = 唔估算。Meta 香港費率會變 — 數字只供參考。</div>
        )}
      </section>

      {/* §5 決策表（員工指引同內容） */}
      <section className="rounded-xl border border-line bg-panel p-3 flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-t1">§5 決策表（員工指引同內容 — 可複製去通告）</h3>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] text-t2 border-b border-line bg-panel-2">
                <th className="px-2.5 py-1.5 font-medium">場景</th>
                <th className="px-2.5 py-1.5 font-medium">用邊個</th>
                <th className="px-2.5 py-1.5 font-medium">點解</th>
              </tr>
            </thead>
            <tbody className="text-t1">
              <tr className="border-b border-line/60">
                <td className="px-2.5 py-1.5">病人主動查詢，窗口內</td>
                <td className="px-2.5 py-1.5 font-semibold">API（呢個系統）</td>
                <td className="px-2.5 py-1.5 text-t2">AI 草稿/自動化；10 月起逐條收費但仍係主力</td>
              </tr>
              <tr className="border-b border-line/60">
                <td className="px-2.5 py-1.5">窗口已過，一次性跟進</td>
                <td className="px-2.5 py-1.5 font-semibold">手機 App</td>
                <td className="px-2.5 py-1.5 text-t2">免費、零審批、echo 回流</td>
              </tr>
              <tr className="border-b border-line/60">
                <td className="px-2.5 py-1.5">預約提醒／確認（主動、批量）</td>
                <td className="px-2.5 py-1.5 font-semibold">Template（API）</td>
                <td className="px-2.5 py-1.5 text-t2">人手做唔到規模；收費但必要</td>
              </tr>
              <tr>
                <td className="px-2.5 py-1.5">群發推廣</td>
                <td className="px-2.5 py-1.5 font-semibold text-danger">唔做</td>
                <td className="px-2.5 py-1.5 text-t2">高封號風險（W-5），亦唔係診所需要</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="text-[11.5px] text-t2 flex flex-col gap-1">
          <span>
            <b>W-5 App 使用三條安全線</b>：① 只覆主動搵過你嘅人；② 唔好複製同一段派多人；③ 叫停即停。
          </span>
          <span>
            <b>維護要求</b>：coexistence 要求 Business App 至少每 13 日開一次先維持帳號 active — 前台日常有用就自然滿足；
            某間店部機閒置，要有人記得定期開。
          </span>
        </div>
      </section>
    </div>
  );
}

function ClinicRows({ clinic, rows }: { clinic: string; rows: Row[] }) {
  if (rows.length === 0) {
    return (
      <tr className="border-b border-line/60">
        <td className="px-3 py-2 text-t1 font-medium">{clinic}</td>
        <td className="px-3 py-2 text-t3" colSpan={5}>
          本月零 outbound
        </td>
      </tr>
    );
  }
  return (
    <>
      {rows.map((r) => (
        <tr key={`${clinic}-${r.category ?? "null"}`} className="border-b border-line/60">
          <td className="px-3 py-2 text-t1 font-medium">{clinic}</td>
          <td className="px-3 py-2 text-t2">{categoryLabel(r.category)}</td>
          <td className="px-3 py-2 text-right text-t1">{r.staffSent}</td>
          <td className="px-3 py-2 text-right text-t1">{r.aiSent}</td>
          <td className="px-3 py-2 text-right text-t1">{r.systemSent}</td>
          <td className="px-3 py-2 text-right text-t1 font-semibold">{r.total}</td>
        </tr>
      ))}
    </>
  );
}
