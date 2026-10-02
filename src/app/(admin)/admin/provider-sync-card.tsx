"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * ★ cwi-roster-20261001：醫生名錄同步健康卡（hub 總覽）— 公司同步卡隔離（同頁、同設計語言）。
 *
 * - 狀態：上次同步（時間 / ok|failed）+ 重點數字（加咗幾多 / 刪咗幾多）
 * - 對唔上嘅店（unmatchedClinics）= 紅字（要人手核對 clinic code）
 * - stale 店（staleClinics）= 黃字「資料過時 — 今次只加唔刪」
 * - 「立即同步醫生名錄」= POST /api/admin/provider-sync（同每鐘 :20 cron 同源）
 *
 * 跟 admin 頁現有設計語言（bg-panel / border-line / p-5）；零新依賴。
 */

type LastRun = {
  id: string;
  runAt: string;
  status: string;
  summary: Record<string, unknown> | null;
  error: string | null;
};
type Status = { lastRun: LastRun | null };

export function ProviderSyncCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const res = await fetch("/api/admin/provider-sync", { cache: "no-store" });
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
      const res = await fetch("/api/admin/provider-sync", { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        providersUpserted?: number;
        linksAdded?: number;
        linksPruned?: number;
        pruneDeferred?: number;
        unmatchedClinics?: string[];
        staleClinics?: string[];
      };
      if (!res.ok || !data.ok) {
        setActionMsg(`同步失敗：${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      const parts = [
        `同步完成（醫生 ${data.providersUpserted ?? 0} 位 / 加 ${data.linksAdded ?? 0} 條 / 刪 ${data.linksPruned ?? 0} 條）`,
      ];
      if ((data.pruneDeferred ?? 0) > 0) parts.push(`${data.pruneDeferred} 條暫緩（有未完結預約）`);
      setActionMsg(parts.join("，"));
      await load();
    } catch {
      setActionMsg("同步失敗（網絡錯誤）");
    } finally {
      setBusy(false);
    }
  };

  const last = status?.lastRun;
  const unmatched: string[] = (last?.summary?.unmatchedClinics as string[] | undefined) ?? [];
  const stale: string[] = (last?.summary?.staleClinics as string[] | undefined) ?? [];

  return (
    <section className="bg-panel rounded-[26px] border border-line p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[18px] font-normal text-t1">醫生名錄同步（workforce 名錄）</h2>
        <button
          onClick={() => void syncNow()}
          disabled={busy}
          className="rounded-full border border-line-strong px-4 py-1.5 text-sm text-t1 hover:border-brand transition-colors disabled:opacity-50"
        >
          {busy ? "處理中…" : "立即同步醫生名錄"}
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
                    — 對上 {String(last.summary.clinicsMatched ?? "—")} 間店 / 醫生 {String(last.summary.providersUpserted ?? "—")} 位 / 加{" "}
                    {String(last.summary.linksAdded ?? "—")} 條 / 刪 {String(last.summary.linksPruned ?? "—")} 條
                    {Number(last.summary.pruneDeferred ?? 0) > 0 && ` / 暫緩 ${String(last.summary.pruneDeferred)} 條`}
                  </span>
                )}
                {last.error && <span className="text-danger-text"> — {last.error}</span>}
              </>
            ) : (
              "從未同步（每鐘 :20 自動；可上「立即同步醫生名錄」）"
            )}
          </p>

          {actionMsg && (
            <p className={`text-xs mb-3 ${actionMsg.startsWith("同步失敗") ? "text-danger-text" : "text-ok-text"}`}>
              {actionMsg}
            </p>
          )}

          {unmatched.length > 0 && (
            <p className="text-xs mb-2 font-medium text-danger-text">
              對唔上嘅店（workforce 有、inbox 無）：{unmatched.join("、")} — 要核對 /admin/clinics 嘅 code。
            </p>
          )}
          {stale.length > 0 && (
            <p className="text-xs mb-2 font-medium text-warn-text">
              資料過時 — 今次只加唔刪：{stale.join("、")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
