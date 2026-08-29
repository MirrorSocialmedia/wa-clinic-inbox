"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 學習迴路 review queue client（Phase E — cwi-ai-20260825-t5）。
 *
 * PROPOSED 先（卡片全展開）；APPROVED/REJECTED 摺埋（<details>）。
 * 卡：title + evidence 展開（改寫對照 draft→final 左右欄；wamid/對話 撳跳 inbox）
 * + FAQ/TEMPLATE 卡有 Q/A 輸入欄 +〔批准〕〔拒絕〕。WORKFLOW_DIFF 批准 → 出 DRAFT（兩段式，去 /admin/workflows 發佈）。
 *
 * 所有 mutation 經 /api/admin/suggestions（ADMIN-only，requireAdmin）。
 */
interface EvidenceSample {
  draftScrubbed: string;
  finalScrubbed?: string;
  wamid: string | null;
  conversationId: string;
}
interface Suggestion {
  id: string;
  clinicId: string | null;
  kind: "FAQ" | "TEMPLATE" | "WORKFLOW_DIFF";
  title: string;
  payload: Record<string, unknown> & {
    proposedFaq?: unknown;
    category?: string;
    count?: number;
    key?: string;
    current?: Record<string, unknown>;
    suggestedParams?: Record<string, unknown>;
    stats?: Record<string, number>;
  };
  evidence: { counts: Record<string, number>; samples: EvidenceSample[] };
  status: "PROPOSED" | "APPROVED" | "REJECTED";
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

const KIND_TAG: Record<Suggestion["kind"], string> = {
  FAQ: "bg-brand-soft text-brand-text",
  TEMPLATE: "bg-warn-soft text-warn-text",
  WORKFLOW_DIFF: "bg-line text-t2",
};

function ConvLink({ s }: { s: EvidenceSample }) {
  return (
    <a
      href={`/inbox/inbox?conv=${encodeURIComponent(s.conversationId)}`}
      target="_blank"
      rel="noreferrer"
      className="text-brand underline break-all"
      title={s.wamid ?? ""}
    >
      對話
      {s.wamid ? `（${s.wamid.slice(-6)}）` : ""}
    </a>
  );
}

function EvidenceView({ ev }: { ev: Suggestion["evidence"] }) {
  return (
    <div className="mt-2 text-xs space-y-1">
      {ev.samples.length === 0 ? (
        <p className="text-t3">（無文本樣本 — 僅計數：{JSON.stringify(ev.counts)}）</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-t3 text-left">
              <th className="py-1 pr-2 text-[10.5px] uppercase tracking-[0.08em] text-t2 font-semibold w-1/3">AI 草稿</th>
              <th className="py-1 pr-2 text-[10.5px] uppercase tracking-[0.08em] text-t2 font-semibold w-1/3">最終發出</th>
              <th className="py-1 text-[10.5px] uppercase tracking-[0.08em] text-t2 font-semibold">對話</th>
            </tr>
          </thead>
          <tbody>
            {ev.samples.map((s, i) => (
              <tr key={i} className="border-t border-line align-top">
                <td className="py-1 pr-2 whitespace-pre-wrap break-words">{s.draftScrubbed || <span className="text-t3">（無）</span>}</td>
                <td className="py-1 pr-2 whitespace-pre-wrap break-words">{s.finalScrubbed ?? <span className="text-t3">（被棄 — 無最終版）</span>}</td>
                <td className="py-1"><ConvLink s={s} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function WfDiff({ p }: { p: Suggestion["payload"] }) {
  if (p.key !== "booking-session" || !p.suggestedParams) return null;
  const cur = p.current ?? {};
  const keys = Object.keys(p.suggestedParams);
  return (
    <div className="mt-2 text-xs space-y-1">
      {p.stats ? (
        <p className="text-t3">
          上週 session {p.stats.sessions} 條，轉人手 {p.stats.handoff} 條（{Math.round((p.stats.handoff / p.stats.sessions) * 100)}%）
        </p>
      ) : null}
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-t3 text-left">
            <th className="py-1 pr-2 text-[10.5px] uppercase tracking-[0.08em] text-t2 font-semibold">參數</th>
            <th className="py-1 pr-2 text-[10.5px] uppercase tracking-[0.08em] text-t2 font-semibold">現行</th>
            <th className="py-1 text-[10.5px] uppercase tracking-[0.08em] text-t2 font-semibold">建議</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k} className="border-t border-line">
              <td className="py-1 pr-2 font-mono">{k}</td>
              <td className="py-1 pr-2">{String(cur[k] ?? "—")}</td>
              <td className={`py-1 ${JSON.stringify(cur[k]) !== JSON.stringify(p.suggestedParams![k]) ? "text-danger-text font-semibold" : "text-t3"}`}>
                {String(p.suggestedParams![k])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-t3">
        批准後只出 <b>DRAFT</b>（兩段式）— 去 <a className="text-brand underline" href="/admin/workflows">/admin/workflows</a> 發佈先生效。
      </p>
    </div>
  );
}

function SuggestionCard({ s, onChanged }: { s: Suggestion; onChanged: () => void }) {
  const [open, setOpen] = useState(s.status === "PROPOSED");
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const isFaq = s.kind === "FAQ" || s.kind === "TEMPLATE";

  const decide = useCallback(
    async (decision: "APPROVED" | "REJECTED") => {
      setBusy(true);
      setMsg(null);
      try {
        const body: Record<string, unknown> = { decision };
        if (decision === "APPROVED" && isFaq) body.edits = { faq: { q, a } };
        const res = await fetch(`/api/admin/suggestions/${s.id}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMsg({ ok: false, text: j.message ?? j.error ?? `HTTP ${res.status}` });
          return;
        }
        setMsg({ ok: true, text: decision === "APPROVED" ? "已批准（已生效 / 已出草稿）" : "已拒絕" });
        setTimeout(onChanged, 600);
      } finally {
        setBusy(false);
      }
    },
    [s.id, isFaq, q, a, onChanged]
  );

  const body = (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${KIND_TAG[s.kind]}`}>{s.kind}</span>
        <span className="font-semibold text-t1">{s.title}</span>
      </div>
      <EvidenceView ev={s.evidence} />
      <WfDiff p={s.payload} />
      {s.status === "PROPOSED" ? (
        <div className="mt-3 space-y-2">
          {isFaq ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-t3">
                Q（問題）
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="mt-1 w-full rounded-full border border-line bg-panel px-3 py-2 text-sm text-t1"
                  placeholder="例：營業時間係幾點？"
                />
              </label>
              <label className="text-xs text-t3">
                A（標準答案）
                <input
                  value={a}
                  onChange={(e) => setA(e.target.value)}
                  className="mt-1 w-full rounded-full border border-line bg-panel px-3 py-2 text-sm text-t1"
                  placeholder="例：一至六 10:00-18:00；日公假"
                />
              </label>
            </div>
          ) : null}
          {msg ? <p className={`text-sm ${msg.ok ? "text-ok-text" : "text-danger-text"}`}>{msg.text}</p> : null}
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => decide("APPROVED")}
              className="text-sm px-3.5 py-1.5 rounded-full bg-brand text-panel font-semibold disabled:opacity-50"
            >
              批准
            </button>
            <button
              disabled={busy}
              onClick={() => decide("REJECTED")}
              className="text-sm px-3.5 py-1.5 rounded-full border border-line bg-panel text-t2 hover:bg-panel-2 disabled:opacity-50"
            >
              拒絕
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-t3">
          {s.status === "APPROVED" ? "已批准" : "已拒絕"}
          {s.decidedAt ? ` @ ${new Date(s.decidedAt).toLocaleString("zh-HK")}` : ""}
        </p>
      )}
    </div>
  );

  if (s.status !== "PROPOSED") {
    return (
      <details className="bg-panel rounded-[22px] border border-line mb-2 opacity-70">
        <summary className="cursor-pointer px-4 py-2 text-sm text-t2 flex items-center gap-2">
          <span className={`text-[11px] px-2 py-0.5 rounded-full ${KIND_TAG[s.kind]}`}>{s.kind}</span>
          <span>{s.title}</span>
          <span className="text-t3">（{s.status}）</span>
        </summary>
        {body}
      </details>
    );
  }
  return (
    <div className="bg-panel rounded-[22px] border border-line mb-2">
      <button className="w-full text-left px-4 py-2 flex items-center gap-2" onClick={() => setOpen(!open)}>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${KIND_TAG[s.kind]}`}>{s.kind}</span>
        <span className="font-semibold text-t1">{s.title}</span>
        <span className="ml-auto text-t3 text-xs">{open ? "收起 ▲" : "展開 ▼"}</span>
      </button>
      {open ? body : null}
    </div>
  );
}

export default function SuggestionsAdmin() {
  const [rows, setRows] = useState<Suggestion[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetch("/api/admin/suggestions")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        setRows(j.suggestions as Suggestion[]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const proposed = rows?.filter((r) => r.status === "PROPOSED") ?? [];
  const decided = rows?.filter((r) => r.status !== "PROPOSED") ?? [];

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-bold text-t1 mb-1">AI 建議（學習迴路）</h1>
      <p className="text-sm text-t3 mb-4">
        週一 05:00 自動 mining（上週數據）。批准 = 生效（FAQ 入 greetingConfig / WORKFLOW_DIFF 出 DRAFT）；拒絕 = 純標記。
      </p>
      {error ? <p className="text-sm text-danger-text mb-3">{error}</p> : null}
      {!rows ? <p className="text-sm text-t3">載入中…</p> : null}
      {rows && rows.length === 0 ? <p className="text-sm text-t3">暫時冇新建議</p> : null}
      {rows && rows.length > 0 ? (
        <>
          <p className="text-xs text-t3 mb-2">待審（{proposed.length}）</p>
          {proposed.length === 0 ? <p className="text-sm text-t3 mb-4">暫時冇新建議</p> : null}
          {proposed.map((s) => (
            <SuggestionCard key={s.id} s={s} onChanged={load} />
          ))}
          {decided.length > 0 ? (
            <p className="text-xs text-t3 mt-4 mb-2">已決定（{decided.length}）</p>
          ) : null}
          {decided.map((s) => (
            <SuggestionCard key={s.id} s={s} onChanged={load} />
          ))}
        </>
      ) : null}
    </div>
  );
}
