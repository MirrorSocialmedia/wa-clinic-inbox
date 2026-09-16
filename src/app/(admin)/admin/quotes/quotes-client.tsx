"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Trash2, RefreshCw } from "lucide-react";

/**
 * 報價確認隊列 client — cwi-followup-p4-20260916 S6（MD §5.3/S3）。
 * CWM 抽到嘅報價項目 → ✓ 收貨（confirm）/ ✎ 改（correct，可順手教字典）/ ✗ 丟（discard）。
 * 鐵律 §6.5：suggest/consider = 未做（intent=not_done 顯示「建議·未做」）。
 * 零原始電話（只 patientApricotId 對照碼）；臨床全文唔過界。
 */
interface Quote {
  id: string;
  patientApricotId: string;
  clinicCode: string;
  sourceVisitDate: string;
  text: string;
  termShorthand: string | null;
  nameCn: string | null;
  amountMin: number | null;
  amountMax: number | null;
  perUnit: boolean;
  fdiTeeth: string[];
  intent: "not_done" | "unknown";
  certainty: "high" | "low";
  source: "parser" | "llm" | "manual";
  status: "pending" | "confirmed" | "corrected" | "discarded";
}
interface Term {
  shorthand: string;
  nameCn: string;
}

const STATUS_TABS: { key: Quote["status"] | "all"; label: string }[] = [
  { key: "pending", label: "待確認" },
  { key: "confirmed", label: "已收貨" },
  { key: "corrected", label: "已改" },
  { key: "discarded", label: "已丟" },
  { key: "all", label: "全部" },
];
const STATUS_PARAM: Record<string, string> = {
  all: "pending,confirmed,corrected,discarded",
  pending: "pending",
  confirmed: "confirmed",
  corrected: "corrected",
  discarded: "discarded",
};

function fmtAmount(q: Quote): string {
  if (q.amountMin == null) return "";
  const base = q.amountMax != null && q.amountMax !== q.amountMin ? `${q.amountMin.toLocaleString()}–${q.amountMax.toLocaleString()}` : q.amountMin.toLocaleString();
  return `$${base}${q.perUnit ? "@" : ""}`;
}

export default function Quotes() {
  const [tab, setTab] = useState<Quote["status"] | "all">("pending");
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 編輯（✎）state
  const [editId, setEditId] = useState<string | null>(null);
  const [editMin, setEditMin] = useState("");
  const [editMax, setEditMax] = useState("");
  const [editShorthand, setEditShorthand] = useState("");
  const [teachNew, setTeachNew] = useState(false);
  const [teachShorthand, setTeachShorthand] = useState("");
  const [teachNameCn, setTeachNameCn] = useState("");
  const [teachNameEn, setTeachNameEn] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const [qRes, tRes] = await Promise.all([
        fetch(`/api/admin/quotes?status=${STATUS_PARAM[tab]}&limit=200`, { cache: "no-store" }),
        fetch("/api/admin/clinical-terms", { cache: "no-store" }).catch(() => null),
      ]);
      if (tRes && tRes.ok) {
        const tj = (await tRes.json()) as { terms: Term[] };
        setTerms(tj.terms);
      }
      if (!qRes.ok) throw new Error(`HTTP ${qRes.status}`);
      const j = (await qRes.json()) as { quotes: Quote[] };
      setQuotes(j.quotes);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, action: "confirm" | "correct" | "discard", extra?: Record<string, unknown>) => {
    setBusy(id);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action, ...extra }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { status: string; termMapUpserted?: boolean };
      setMsg(
        action === "discard" ? "已丟" : action === "confirm" ? "已收貨" : "已改" + (j.termMapUpserted ? "（已教字典）" : "")
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "操作失敗");
    } finally {
      setBusy(null);
      setEditId(null);
    }
  };

  const startEdit = (q: Quote) => {
    setEditId(q.id);
    setEditMin(q.amountMin != null ? String(q.amountMin) : "");
    setEditMax(q.amountMax != null && q.amountMax !== q.amountMin ? String(q.amountMax) : "");
    setEditShorthand(q.termShorthand ?? "");
    setTeachNew(!q.termShorthand);
    setTeachShorthand("");
    setTeachNameCn(q.nameCn ?? "");
    setTeachNameEn("");
  };

  const submitEdit = (q: Quote) => {
    const fields: Record<string, unknown> = {};
    const mn = Number(editMin);
    const mx = Number(editMax);
    if (editMin !== "" && Number.isFinite(mn)) fields.amountMin = mn;
    if (editMax !== "" && Number.isFinite(mx) && mx !== mn) fields.amountMax = mx;
    if (teachNew) {
      if (!teachShorthand.trim() || !teachNameCn.trim()) {
        setErr("教字典：速記 + 標準名稱必填");
        return;
      }
      fields.termShorthand = teachShorthand.trim();
      fields.nameCn = teachNameCn.trim();
      fields.teachTerm = {
        shorthand: teachShorthand.trim(),
        nameCn: teachNameCn.trim(),
        nameEn: teachNameEn.trim() || undefined,
        usedFor: ["quote_extraction"],
      };
    } else if (editShorthand && editShorthand !== q.termShorthand) {
      const t = terms.find((x) => x.shorthand === editShorthand);
      fields.termShorthand = editShorthand;
      if (t) fields.nameCn = t.nameCn;
    }
    void decide(q.id, "correct", { fields });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4" data-e2e="q-root">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-t1">報價確認隊列</h1>
          <p className="text-[12px] text-t3 mt-1">
            由臨床記錄抽到嘅報價項目。✓ 收貨 · ✎ 改（可順手教字典）· ✗ 丟。「建議／未做」= 只係報價，唔係已完成治療。
          </p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 text-[13px] text-t2 hover:text-t1 border border-line rounded-lg px-3 py-1.5"
          data-e2e="q-refresh"
        >
          <RefreshCw size={13} /> 重新整理
        </button>
      </div>

      {/* tabs */}
      <div className="flex gap-1 border-b border-line" data-e2e="q-tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-[13px] border-b-2 -mb-px ${
              tab === t.key ? "border-brand text-t1 font-medium" : "border-transparent text-t3 hover:text-t2"
            }`}
            data-e2e={`q-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-[13px] text-t3 py-10 text-center">載入中…</div>
      ) : loadErr ? (
        <div className="bg-danger-soft text-danger-text text-[13px] rounded-xl p-3" data-e2e="q-err">{loadErr}</div>
      ) : quotes.length === 0 ? (
        <div className="text-center py-12 text-[13px] text-t3" data-e2e="q-empty">呢個分類冇報價項目</div>
      ) : (
        <div className="space-y-2">
          {quotes.map((q) => (
            <div key={q.id} className="bg-panel border border-line rounded-xl p-3" data-e2e={`q-row-${q.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] text-t1 font-medium">{q.nameCn ?? q.text}</span>
                    {q.intent === "not_done" && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-warn-soft text-warn-text" data-e2e="q-intent">
                        建議·未做
                      </span>
                    )}
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] ${
                        q.certainty === "high" ? "bg-ok-soft text-ok-text" : "bg-panel-2 text-t3"
                      }`}
                    >
                      {q.certainty === "high" ? "高信心" : "待核"}
                    </span>
                    {fmtAmount(q) && <span className="text-[13px] text-t1 font-mono">{fmtAmount(q)}</span>}
                  </div>
                  <div className="text-[11px] text-t3 mt-1 truncate" title={q.text}>
                    原文：{q.text}
                    {q.fdiTeeth.length > 0 && ` · 牙位 ${q.fdiTeeth.join(", ")}`}
                    {" · "}
                    {q.sourceVisitDate} · {q.clinicCode} · 病人 {q.patientApricotId.slice(0, 8)}…
                  </div>
                </div>
                {editId !== q.id && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => void decide(q.id, "confirm")}
                      disabled={busy === q.id}
                      className="inline-flex items-center gap-1 bg-ok-soft text-ok-text rounded-lg px-2.5 py-1.5 text-[12px] hover:opacity-90 disabled:opacity-40"
                      data-e2e={`q-confirm-${q.id}`}
                      title="收貨"
                    >
                      <Check size={13} /> 收貨
                    </button>
                    <button
                      onClick={() => startEdit(q)}
                      disabled={busy === q.id}
                      className="inline-flex items-center gap-1 bg-panel-2 text-t2 rounded-lg px-2.5 py-1.5 text-[12px] hover:bg-panel-3 disabled:opacity-40"
                      data-e2e={`q-correct-${q.id}`}
                      title="改"
                    >
                      <Pencil size={13} /> 改
                    </button>
                    <button
                      onClick={() => void decide(q.id, "discard")}
                      disabled={busy === q.id}
                      className="inline-flex items-center gap-1 bg-panel-2 text-t3 rounded-lg px-2.5 py-1.5 text-[12px] hover:text-danger-text disabled:opacity-40"
                      data-e2e={`q-discard-${q.id}`}
                      title="丟"
                    >
                      <Trash2 size={13} /> 丟
                    </button>
                  </div>
                )}
              </div>

              {/* 編輯區 */}
              {editId === q.id && (
                <div className="mt-3 pt-3 border-t border-line space-y-2" data-e2e={`q-edit-${q.id}`}>
                  <div className="flex flex-wrap gap-2 items-center">
                    <input
                      className="bg-panel-2 border border-line rounded-lg px-2.5 py-1.5 text-[13px] text-t1 w-28 focus:outline-none focus:border-brand"
                      placeholder="金額（低）"
                      value={editMin}
                      onChange={(e) => setEditMin(e.target.value.replace(/[^\d]/g, ""))}
                      data-e2e="q-edit-min"
                    />
                    <input
                      className="bg-panel-2 border border-line rounded-lg px-2.5 py-1.5 text-[13px] text-t1 w-28 focus:outline-none focus:border-brand"
                      placeholder="金額（高·選填）"
                      value={editMax}
                      onChange={(e) => setEditMax(e.target.value.replace(/[^\d]/g, ""))}
                      data-e2e="q-edit-max"
                    />
                    <select
                      className="bg-panel-2 border border-line rounded-lg px-2 py-1.5 text-[13px] text-t1 focus:outline-none focus:border-brand"
                      value={editShorthand}
                      onChange={(e) => setEditShorthand(e.target.value)}
                      data-e2e="q-edit-term"
                    >
                      <option value="">（唔落術語表）</option>
                      {terms.map((t) => (
                        <option key={t.shorthand} value={t.shorthand}>
                          {t.shorthand} → {t.nameCn}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="flex items-center gap-1.5 text-[12px] text-t2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={teachNew}
                      onChange={(e) => setTeachNew(e.target.checked)}
                      className="accent-brand"
                      data-e2e="q-teach-toggle"
                    />
                    呢個係新術語 — 順手教字典
                  </label>
                  {teachNew && (
                    <div className="flex flex-wrap gap-2">
                      <input
                        className="bg-panel-2 border border-line rounded-lg px-2.5 py-1.5 text-[13px] text-t1 w-28 focus:outline-none focus:border-brand"
                        placeholder="速記（如 x）"
                        value={teachShorthand}
                        onChange={(e) => setTeachShorthand(e.target.value)}
                        data-e2e="q-teach-shorthand"
                      />
                      <input
                        className="bg-panel-2 border border-line rounded-lg px-2.5 py-1.5 text-[13px] text-t1 w-40 focus:outline-none focus:border-brand"
                        placeholder="標準名稱（如 拔牙）"
                        value={teachNameCn}
                        onChange={(e) => setTeachNameCn(e.target.value)}
                        data-e2e="q-teach-namecn"
                      />
                      <input
                        className="bg-panel-2 border border-line rounded-lg px-2.5 py-1.5 text-[13px] text-t1 w-36 focus:outline-none focus:border-brand"
                        placeholder="英文名（選填）"
                        value={teachNameEn}
                        onChange={(e) => setTeachNameEn(e.target.value)}
                        data-e2e="q-teach-nameen"
                      />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => submitEdit(q)}
                      disabled={busy === q.id}
                      className="bg-brand text-white rounded-lg px-3 py-1.5 text-[12px] font-medium hover:opacity-90 disabled:opacity-40"
                      data-e2e="q-edit-save"
                    >
                      儲存改動
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      className="text-[12px] text-t3 hover:text-t2 px-2"
                      data-e2e="q-edit-cancel"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {msg && (
        <div className="text-[12px] text-ok-text" data-e2e="q-msg">
          {msg}
        </div>
      )}
      {err && (
        <div className="text-[12px] text-danger-text" data-e2e="q-err-msg">
          {err}
        </div>
      )}
    </div>
  );
}
