"use client";

import { useEffect, useState } from "react";

/**
 * ★ cwi-advice-20261024：醫生建議跟進卡 — 原因／原文／來源／狀態四行。
 *
 * 🔴 原文唔喺 wa-inbox 存：task.contextJson 只有欄名 + 觸發字；原文句即時問
 *   GET /api/followups/tasks/:id/advice（CWM 落 EXTERNAL_ADVICE_VIEWED）。攞唔到 → 顯示欄名 + 觸發字。
 */
interface AdviceCtx {
  visitDate?: string;
  clinicCode?: string;
  doctorName?: string | null;
  providerCode?: string | null;
  matches?: { field: string; keyword: string }[];
  keywords?: string[];
  quoteItems?: string[];
}

interface Match {
  field: string;
  keyword: string;
  snippet: string;
}

/** 句入面觸發字標黃（唔分大細楷；前後唔係英文字母 — 同 CWM 口徑） */
export function highlightKeyword(text: string, keyword: string): React.ReactNode {
  const esc = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(`(?<![a-z])(${esc})(?![a-z])`, "i");
  const m = re.exec(text);
  if (!m) return text;
  return (
    <>
      {text.slice(0, m.index)}
      <mark className="bg-warn-soft text-t1 rounded px-0.5">{m[0]}</mark>
      {text.slice(m.index + m[0].length)}
    </>
  );
}

function daysSince(dateStr: string): number {
  const t = new Date(`${dateStr}T00:00:00+08:00`).getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[12px] leading-[1.6]">
      <span className="shrink-0 w-8 text-t3">{k}</span>
      <span className="min-w-0 flex-1 text-t1 break-words">{children}</span>
    </div>
  );
}

export function AdviceReasonRows({ taskId, contextJson }: { taskId: string; contextJson: unknown }) {
  const c = (contextJson ?? {}) as AdviceCtx;
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setMatches(null);
    setFailed(false);
    fetch(`/api/followups/tasks/${encodeURIComponent(taskId)}/advice`, { cache: "no-store" })
      .then(async (r) => {
        if (!alive) return;
        if (!r.ok) return setFailed(true);
        const d = (await r.json()) as { matches?: Match[] };
        setMatches(d.matches ?? []);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [taskId]);

  const fields = [...new Set((c.matches ?? []).map((m) => m.field))];
  const kws = c.keywords ?? [...new Set((c.matches ?? []).map((m) => m.keyword))];
  const source = [
    c.visitDate ? c.visitDate.slice(5).replace("-", "/") : null,
    c.clinicCode,
    c.doctorName ?? c.providerCode ?? null,
    fields.join("、") || null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mb-2 rounded-2xl bg-panel-2 px-3 py-2 space-y-0.5" data-e2e="fu-advice-rows">
      <Row k="原因">
        {kws.length > 0 ? `診症記錄有「${kws.join("／")}」` : "醫生建議跟進"}
        {(c.quoteItems ?? []).length > 0 && <span className="text-t3"> · 同日報價：{c.quoteItems!.join("、")}</span>}
      </Row>
      <Row k="原文">
        {matches === null && !failed ? (
          <span className="text-t3">載入中…</span>
        ) : failed || !matches?.length ? (
          <span className="text-t3">暫時攞唔到原文（{fields.join("、") || "診症記錄"}）— 可以喺病人記錄「診症及處方」睇</span>
        ) : (
          <span className="space-y-0.5 block" data-e2e="fu-advice-snippet">
            {matches.map((m, i) => (
              <span key={i} className="block">
                {highlightKeyword(m.snippet, m.keyword)}
                {matches.length > 1 && <span className="text-t3 text-[10.5px]">（{m.field}）</span>}
              </span>
            ))}
          </span>
        )}
      </Row>
      {source && <Row k="來源">{source}</Row>}
      {c.visitDate && <Row k="狀態">未預約 · 診症後 {daysSince(c.visitDate)} 日</Row>}
      <div className="text-[10.5px] text-t3 pt-0.5">訊息唔會提病情細節同金額；原文只俾員工睇</div>
    </div>
  );
}
