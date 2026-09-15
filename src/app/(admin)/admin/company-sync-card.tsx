"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * ★ cwi-followup-p0-20260915（MD §1.1）：公司同步健康卡（hub 總覽）。
 *
 * - 狀態：上次同步（時間 / ok|failed / 重點數字）+ 公司快取清單
 * - sourceId=null 嘅公司 = 紅字「未配對 — 要人手配對」（MD §1.1 migration 注意）
 * - 「立即同步」= POST /api/admin/company-sync（同 03:00 cron 同源）
 * - 人手配對：未配對公司揀 remote 公司 → POST /api/admin/company-sync/pair
 *
 * 跟 admin 頁現有設計語言（bg-panel / border-line / p-5）；零新依賴。
 */

type LocalCompany = { id: string; code: string; name: string; enabled: boolean; sourceId: string | null };
type RemoteCompany = { id: string; name: string };
type LastRun = {
  id: string;
  runAt: string;
  status: string;
  summary: Record<string, unknown> | null;
  error: string | null;
};
type Status = {
  lastRun: LastRun | null;
  companies: LocalCompany[];
  remote: { companies: RemoteCompany[] } | null;
};

export function CompanySyncCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [pairPick, setPairPick] = useState<Record<string, string>>({}); // localCompanyId → remoteId

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const res = await fetch("/api/admin/company-sync", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as Status);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "載入失敗");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const syncNow = async () => {
    setBusy(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/admin/company-sync", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string; clinicsMapped?: number; nameMatched?: number };
      if (!res.ok || !data.ok) {
        setActionMsg(`同步失敗：${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setActionMsg(`同步完成（新對 ${data.nameMatched ?? 0} 間公司 / ${data.clinicsMapped ?? 0} 間店）`);
      await load();
    } catch {
      setActionMsg("同步失敗（網絡錯誤）");
    } finally {
      setBusy(false);
    }
  };

  const pair = async (companyId: string) => {
    const sourceId = pairPick[companyId] || null;
    setBusy(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/admin/company-sync/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId, sourceId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setActionMsg(`配對失敗：${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setActionMsg(sourceId ? "配對成功" : "已取消配對");
      await load();
    } catch {
      setActionMsg("配對失敗（網絡錯誤）");
    } finally {
      setBusy(false);
    }
  };

  const last = status?.lastRun;
  const unmatched = (status?.companies ?? []).filter((c) => !c.sourceId);

  return (
    <section className="bg-panel rounded-[26px] border border-line p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[18px] font-normal text-t1">公司同步（workforce 主資料）</h2>
        <button
          onClick={() => void syncNow()}
          disabled={busy}
          className="rounded-full border border-line-strong px-4 py-1.5 text-sm text-t1 hover:border-brand transition-colors disabled:opacity-50"
        >
          {busy ? "處理中…" : "立即同步"}
        </button>
      </div>

      {loadErr && <p className="text-sm text-danger-text mb-3">載入失敗：{loadErr}</p>}
      {!status && !loadErr && <p className="text-sm text-t3">載入中…</p>}

      {status && (
        <>
          <p className="text-xs text-t2 mb-3">
            {last ? (
              <>
                上次同步：{new Date(last.runAt).toLocaleString("zh-HK")}（
                {last.status === "ok" ? (
                  <span className="text-ok-text font-medium">ok</span>
                ) : (
                  <span className="text-danger-text font-medium">failed</span>
                )}
                ）
                {last.summary && (
                  <span>
                    {" "}
                    — remote {String(last.summary.companiesRemote ?? "—")} 間 / 新對 {String(last.summary.nameMatched ?? 0)} 間 / 改店 {String(last.summary.clinicsMapped ?? "—")} 間
                  </span>
                )}
                {last.error && <span className="text-danger-text"> — {last.error}</span>}
              </>
            ) : (
              "從未同步（每日 03:00 自動；可上「立即同步」）"
            )}
            {status.remote === null && <span className="text-warn-text"> — workforce 暫時唔通（remote 清單暫唔通）</span>}
          </p>

          {actionMsg && (
            <p className={`text-xs mb-3 ${actionMsg.startsWith("同步失敗") || actionMsg.startsWith("配對失敗") ? "text-danger-text" : "text-ok-text"}`}>
              {actionMsg}
            </p>
          )}

          <table className="w-full text-sm">
            <thead className="text-left border-b border-line">
              <tr>
                <th className="py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">公司</th>
                <th className="py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">workforce 配對（sourceId）</th>
                <th className="py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">操作</th>
              </tr>
            </thead>
            <tbody>
              {status.companies.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td className="py-2">
                    {c.code}
                    <span className="text-t3 ml-2 text-xs">{c.name}</span>
                  </td>
                  <td className="py-2">
                    {c.sourceId ? (
                      <span className="font-mono text-xs text-t2">{c.sourceId}</span>
                    ) : (
                      <span className="text-xs font-medium text-danger-text">未配對 — 要人手配對</span>
                    )}
                  </td>
                  <td className="py-2">
                    {!c.sourceId && status.remote && (
                      <span className="inline-flex items-center gap-1">
                        <select
                          value={pairPick[c.id] ?? ""}
                          onChange={(e) => setPairPick((p) => ({ ...p, [c.id]: e.target.value }))}
                          className="rounded border border-line px-1.5 py-0.5 text-xs bg-panel"
                        >
                          <option value="">— 揀 workforce 公司 —</option>
                          {status.remote!.companies.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => void pair(c.id)}
                          disabled={busy || !pairPick[c.id]}
                          className="rounded border border-line px-2 py-0.5 text-xs hover:border-brand transition-colors disabled:opacity-40"
                        >
                          配對
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {unmatched.length > 0 && (
            <p className="mt-2 text-xs text-danger-text">
              {unmatched.length} 間公司未配對（name 對唔上 workforce）— 上面人手配對，配好先有公司同步數據。
            </p>
          )}
        </>
      )}
    </section>
  );
}
