"use client";

import { useState, useCallback } from "react";

/**
 * /admin alerts 區塊（Phase 4）：未解決 alert 列表 + 手動標記 resolved。
 * 數據由 server component SSR 落嚟（metadata only）；resolve 用 POST API（冪等）。
 */
export interface AlertItem {
  id: string;
  type: string;
  severity: string;
  clinicCode: string | null;
  detail: unknown;
  createdAt: string;
  resolvedAt: string | null;
}

const SEV_CLS: Record<string, string> = {
  // Organic P2（README 第 5 步）：severity 膠囊 — HIGH 陶土橙實底、MEDIUM 淺橙底
  HIGH: "bg-danger text-panel",
  MEDIUM: "bg-warn text-warn-text",
  LOW: "bg-panel-2 text-t2",
  INFO: "bg-brand-soft text-brand-text",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("zh-HK")} ${d.toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit" })}`;
}

export function AlertsPanel({ alerts }: { alerts: AlertItem[] }) {
  const [list, setList] = useState(alerts);
  const [busy, setBusy] = useState<string | null>(null);

  const resolve = useCallback(async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/admin/alerts/${id}/resolve`, { method: "POST" });
      if (res.ok) {
        const row = (await res.json()) as AlertItem;
        setList((prev) => prev.map((a) => (a.id === id ? { ...a, resolvedAt: row.resolvedAt } : a)));
      }
    } finally {
      setBusy(null);
    }
  }, []);

  if (list.length === 0) {
    return (
      <p className="text-sm text-t2">
        ✅ 冇未解決警報（health-check 每 5 分鐘、quality-check 每日自動檢查）
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {list.map((a) => (
        <li key={a.id} className="flex items-start justify-between gap-3 border border-line rounded-[20px] p-3.5 bg-panel">
          <div className="min-w-0 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${SEV_CLS[a.severity] ?? SEV_CLS.LOW}`}>
                {a.severity}
              </span>
              <span className="font-mono text-t1">{a.type}</span>
              {a.clinicCode && <span className="text-xs text-t2">clinic={a.clinicCode}</span>}
              <span className="text-xs text-t3">{fmtTime(a.createdAt)}</span>
              {a.resolvedAt && (
                <span className="text-[11px] text-ok-text">✓ 已處理 {fmtTime(a.resolvedAt)}</span>
              )}
            </div>
            {a.detail !== null && a.detail !== undefined && (
              <pre className="mt-1 text-[11px] text-t2 whitespace-pre-wrap break-all font-mono max-h-24 overflow-y-auto">
                {typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail, null, 1)}
              </pre>
            )}
          </div>
          {!a.resolvedAt && (
            <button
              onClick={() => void resolve(a.id)}
              disabled={busy === a.id}
              className="shrink-0 text-xs px-2.5 py-1 rounded-full bg-t1 text-canvas disabled:opacity-50"
            >
              {busy === a.id ? "處理中…" : "標記已處理"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
