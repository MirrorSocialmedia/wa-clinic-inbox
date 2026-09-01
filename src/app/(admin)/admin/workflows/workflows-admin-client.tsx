"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { buildGraph, type WorkflowGraph } from "@/lib/workflow/definitions";

/**
 * Workflow 參數化 builder v1 client（Phase D — cwi-ai-20260825-t4）。
 * 跟 (admin)/admin 現有卡片風（clinics/staff 頁同款 layout）。
 *
 * 每 key 一卡三 tab：
 * - 參數：zod schemaHints 驅動表單，兩段式「儲存草稿」→「發佈」（發佈前 diff 對照 ACTIVE 值紅綠標）
 * - 流程圖：唯讀 graph JSON → 手砌 SVG boxes+arrows（唔引 mermaid — 結構固定三四層）
 * - 版本：列 + 每行〔回退到此版〕（confirm dialog 講明 re-publish as v(n+1)）
 *
 * 店 override：頂部店選單（default 全局）；店有自己 ACTIVE → override badge。
 * 所有 mutation 經 /api/admin/workflows（ADMIN-only，requireAdmin）。
 */

interface FieldHint {
  name: string;
  label: string;
  type: "int" | "number" | "string";
  min?: number;
  max?: number;
  maxLength?: number;
}
interface WorkflowInfo {
  key: string;
  active: {
    source: "clinic" | "global" | "defaults";
    version: number;
    params: Record<string, unknown>;
    publishedAt: string | null;
  };
  defaults: Record<string, unknown>;
  schemaHints: FieldHint[];
}
interface VersionRow {
  id: string;
  version: number;
  status: string;
  createdBy: string | null;
  publishedAt: string | null;
  createdAt: string;
  params: Record<string, unknown>;
}
interface ClinicRow {
  id: string;
  code: string;
  name: string;
}

type Tab = "params" | "graph" | "versions";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  const body: { error?: string; issues?: { path: string; message: string }[] } & Record<string, unknown> =
    await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `HTTP ${res.status}`) as Error & { issues?: { path: string; message: string }[] };
    err.issues = body.issues;
    throw err;
  }
  return body as T;
}

/** 表單值（string）→ params 對象（number 欄轉 number；轉唔到 → null = 本地驗證失敗）。 */
function formToParams(form: Record<string, string>, hints: FieldHint[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const h of hints) {
    const raw = (form[h.name] ?? "").trim();
    if (h.type === "string") {
      out[h.name] = raw;
      continue;
    }
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) return null;
    out[h.name] = h.type === "int" ? Math.trunc(n) : n;
  }
  return out;
}

function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleString("zh-HK", { hour12: false }) : "—";
}

// ── 流程圖（手砌 SVG — 結構固定三四層，唔引 mermaid）────────────────────
function GraphSvg({ graph }: { graph: WorkflowGraph }) {
  const { nodes, edges } = graph;
  // 層 = 由 trigger（無入邊）BFS 深度（小圖，迭代到穩定）
  const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < nodes.length; i++) {
    for (const e of edges) {
      const d = depth.get(e.from) ?? 0;
      const cur = depth.get(e.to) ?? 0;
      if (d + 1 > cur) depth.set(e.to, d + 1);
    }
  }
  const layers: string[][] = [];
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    (layers[d] ??= []).push(n.id);
  }
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((ids, d) => ids.forEach((id, i) => pos.set(id, { x: 30 + d * 235, y: 28 + i * 92 })));
  const W = 196;
  const H = 62;
  const width = 30 + layers.length * 235;
  const height = 28 + Math.max(...layers.map((l) => l.length)) * 92 + 12;
  const kindFill: Record<string, string> = { trigger: "#dbeafe", condition: "#fef3c7", action: "#d1fae5" };
  const kindStroke: Record<string, string> = { trigger: "#2563eb", condition: "#d97706", action: "#059669" };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <svg width={width} height={height} className="max-w-full">
      <defs>
        <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + W;
        const y1 = a.y + H / 2;
        const x2 = b.x;
        const y2 = b.y + H / 2;
        const mx = (x1 + x2) / 2;
        return (
          <g key={i}>
            <path d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} fill="none" stroke="#94a3b8" strokeWidth="1.5" markerEnd="url(#wf-arrow)" />
            {e.label ? (
              <text x={mx} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize="10" fill="#64748b">
                {e.label}
              </text>
            ) : null}
          </g>
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const label = n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label;
        const sub = n.subtitle ? (n.subtitle.length > 34 ? `${n.subtitle.slice(0, 33)}…` : n.subtitle) : "";
        return (
          <g key={n.id}>
            <title>{`${n.label}${n.subtitle ? ` — ${n.subtitle}` : ""}`}</title>
            <rect x={p.x} y={p.y} width={W} height={H} rx="8" fill={kindFill[n.kind]} stroke={kindStroke[n.kind]} strokeWidth="1.5" />
            <text x={p.x + 10} y={p.y + (sub ? 24 : 36)} fontSize="12.5" fontWeight="600" fill="#0f172a">
              {label}
            </text>
            {sub ? (
              <text x={p.x + 10} y={p.y + 44} fontSize="10" fill="#475569">
                {sub}
              </text>
            ) : null}
          </g>
        );
      })}
      {byId.size === 0 ? null : null}
    </svg>
  );
}

// ── 每 key 一卡 ────────────────────────────────────────────────────────
function KeyCard({
  wf,
  clinicId,
  versions,
  onChanged,
}: {
  wf: WorkflowInfo;
  clinicId: string | null;
  versions: VersionRow[];
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("params");
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(wf.schemaHints.map((h) => [h.name, String(wf.active.params[h.name] ?? "")]))
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pendingDraft, setPendingDraft] = useState<{ id: string; version: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // ★ cwi-h6 §5：流程圖縮放（0.6–1.4 step 0.2；CSS zoom — 不另開 scroll context / 唔用 position:fixed）
  const [graphZoom, setGraphZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // active 變咗（publish/revert 後）→ 表單值跟埋 ACTIVE（未保存嘅 edit 會清 — 可接受 v1）
  useEffect(() => {
    setForm(Object.fromEntries(wf.schemaHints.map((h) => [h.name, String(wf.active.params[h.name] ?? "")])));
    setFieldErrors({});
  }, [wf.active.params, wf.schemaHints]);

  const hints = wf.schemaHints;
  const active = wf.active.params;

  // 發佈前 diff：form（轉數）vs ACTIVE 值 — 紅 = 現行，綠 = 新值
  const diff = useMemo(() => {
    const params = formToParams(form, hints);
    if (!params) return null;
    const rows: { name: string; label: string; oldV: string; newV: string }[] = [];
    for (const h of hints) {
      const o = active[h.name];
      const n = params[h.name];
      const os = typeof o === "string" ? o : String(o ?? "");
      const ns = typeof n === "string" ? n : String(n ?? "");
      if (os !== ns) rows.push({ name: h.name, label: h.label, oldV: os, newV: ns });
    }
    return rows;
  }, [form, hints, active]);

  const dirty = diff !== null && diff.length > 0;

  const saveDraft = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const params = formToParams(form, hints);
      if (!params) {
        setError("有數字欄轉唔到有效數字 — 請檢查後再試");
        return;
      }
      const out = await api<{ id: string; version: number }>(`/api/admin/workflows/${wf.key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId, params }),
      });
      setPendingDraft({ id: out.id, version: out.version });
      setNotice(`草稿 v${out.version} 已儲存 — 撳「發佈」先生效`);
    } catch (err) {
      const e = err as Error & { issues?: { path: string; message: string }[] };
      if (e.issues?.length) {
        const fe: Record<string, string> = {};
        for (const i of e.issues) fe[i.path] = i.message;
        setFieldErrors(fe);
        setError("參數驗證失敗 — 見欄位提示");
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!pendingDraft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/admin/workflows/${wf.key}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defId: pendingDraft.id }),
      });
      setPendingDraft(null);
      setNotice(`v${pendingDraft.version} 已發佈 — 即刻生效`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRevert = async (v: VersionRow) => {
    const ok = window.confirm(
      `回退 ${wf.key} 到 v${v.version}？\n會以 v(現行最大+1) 重新發佈該版 params（歷史唔改寫）。`
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/admin/workflows/${wf.key}/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId, toVersion: v.version }),
      });
      setNotice(`已回退到 v${v.version}（以新版重新發佈）`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const graph = useMemo(() => buildGraph(wf.key as "triage" | "booking-session" | "reminder", wf.active.params), [wf.key, wf.active.params]);
  const maxVersion = versions.length > 0 ? Math.max(...versions.map((v) => v.version)) : 0;

  return (
    <div className="bg-panel rounded-[22px] border border-line">
      {/* 卡頭：key + override badge */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-t1">{wf.key}</span>
          {clinicId && wf.active.source === "clinic" ? (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-brand text-panel font-semibold">本舖 override</span>
          ) : null}
          <span className="text-xs text-t3">
            {wf.active.source === "defaults"
              ? "code defaults（env 底）"
              : `ACTIVE v${wf.active.version}（${wf.active.source === "clinic" ? "本舖" : "全局"}）· ${fmtDate(wf.active.publishedAt)} 發佈`}
          </span>
        </div>
        <div className="flex gap-1">
          {(["params", "graph", "versions"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs px-3 py-1.5 rounded-full ${tab === t ? "bg-brand text-panel font-semibold" : "text-t2 hover:bg-panel-2"}`}
            >
              {t === "params" ? "參數" : t === "graph" ? "流程圖" : `版本（${versions.length}）`}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {error ? <p className="text-sm text-danger-text mb-3">{error}</p> : null}
        {notice ? <p className="text-sm text-ok-text mb-3">{notice}</p> : null}

        {tab === "params" ? (
          <div className="space-y-3">
            {hints.map((h) => (
              <div key={h.name} className="flex items-start gap-3">
                <div className="w-56 shrink-0 pt-1.5">
                  <label className="text-sm text-t1">{h.label}</label>
                  <div className="text-[11px] text-t3 font-mono">{h.name}</div>
                </div>
                <div className="flex-1">
                  {h.type === "string" ? (
                    (h.maxLength ?? 0) > 100 ? (
                      <textarea
                        rows={2}
                        value={form[h.name] ?? ""}
                        maxLength={h.maxLength}
                        onChange={(e) => setForm((f) => ({ ...f, [h.name]: e.target.value }))}
                        className="w-full text-sm bg-panel border border-line rounded-full px-3 py-2 text-t1"
                      />
                    ) : (
                      <input
                        type="text"
                        value={form[h.name] ?? ""}
                        maxLength={h.maxLength}
                        onChange={(e) => setForm((f) => ({ ...f, [h.name]: e.target.value }))}
                        className="w-full text-sm bg-panel border border-line rounded-full px-3 py-2 text-t1"
                      />
                    )
                  ) : (
                    <input
                      type="number"
                      value={form[h.name] ?? ""}
                      min={h.min}
                      max={h.max}
                      step={h.type === "int" ? 1 : 0.1}
                      onChange={(e) => setForm((f) => ({ ...f, [h.name]: e.target.value }))}
                      className="w-48 text-sm bg-panel border border-line rounded-full px-3 py-2 text-t1 font-mono"
                    />
                  )}
                  {fieldErrors[h.name] ? (
                    <p className="text-xs text-danger-text mt-1">{fieldErrors[h.name]}</p>
                  ) : null}
                  {fieldErrors[h.name] === undefined && String(active[h.name] ?? "") !== (form[h.name] ?? "") ? (
                    <p className="text-[11px] text-t3 mt-1">default：{String(wf.defaults[h.name] ?? "—")}</p>
                  ) : null}
                </div>
              </div>
            ))}

            {/* 發佈前 diff（紅 = 現行 ACTIVE 值，綠 = 新值） */}
            {dirty && diff && diff.length > 0 ? (
              <div className="mt-4 border border-line rounded-[18px] p-3 bg-panel-2">
                <div className="text-xs font-semibold text-t2 mb-2">發佈前 diff（紅 = 現行 → 綠 = 新值）</div>
                {diff.map((d) => (
                  <div key={d.name} className="text-xs font-mono py-0.5">
                    <span className="text-t2">{d.label}：</span>
                    <span className="text-danger-text">{d.oldV || "∅"}</span>
                    <span className="text-t3"> → </span>
                    <span className="text-ok-text">{d.newV || "∅"}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={saveDraft}
                disabled={busy || !dirty}
                className="rounded-full bg-panel-2 border border-line text-t1 text-sm px-4 py-2 hover:border-brand disabled:opacity-40"
              >
                儲存草稿
              </button>
              {pendingDraft ? (
                <button
                  onClick={publish}
                  disabled={busy}
                  className="rounded-full bg-brand text-panel text-sm font-semibold px-4 py-2 hover:bg-brand-hover disabled:opacity-40"
                >
                  發佈 v{pendingDraft.version}
                </button>
              ) : null}
              <button
                onClick={() =>
                  setForm(Object.fromEntries(hints.map((h) => [h.name, String(wf.defaults[h.name] ?? "")])))
                }
                disabled={busy}
                className="text-xs text-t3 hover:text-t1 underline ml-auto"
              >
                填返 code defaults
              </button>
            </div>
          </div>
        ) : null}

        {tab === "graph" ? (
          <div>
            {/* ★ cwi-h6 §5：縮放工具列（0.6–1.4 step 0.2） */}
            <div className="flex items-center gap-1.5 mb-2">
              <button
                onClick={() => setGraphZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))}
                disabled={graphZoom <= 0.6}
                aria-label="縮細"
                className="w-7 h-7 rounded-full border border-line text-t2 hover:text-brand hover:border-brand disabled:opacity-40"
              >
                −
              </button>
              <span className="text-[11px] text-t3 w-10 text-center tabular-nums">{Math.round(graphZoom * 100)}%</span>
              <button
                onClick={() => setGraphZoom((z) => Math.min(1.4, +(z + 0.2).toFixed(1)))}
                disabled={graphZoom >= 1.4}
                aria-label="放大"
                className="w-7 h-7 rounded-full border border-line text-t2 hover:text-brand hover:border-brand disabled:opacity-40"
              >
                ＋
              </button>
              <button onClick={() => setGraphZoom(1)} className="ml-1 text-[11px] text-t3 hover:text-t1 underline">
                重設 100%
              </button>
            </div>
            <div className="overflow-x-auto">
              <div style={{ zoom: graphZoom }}>
                <GraphSvg graph={graph} />
              </div>
              <p className="text-[11px] text-t3 mt-2">
                唯讀流程圖（顯示用）— v1 執行器唔係 graph interpreter；實際執行仍係現有 code path，每決策點讀 ACTIVE params。
              </p>
            </div>
          </div>
        ) : null}

        {tab === "versions" ? (
          versions.length === 0 ? (
            <p className="text-sm text-t3">
              呢個 scope（{clinicId ? "本舖" : "全局"}）未有任何版本 — 喺「參數」tab 存草稿 + 發佈先有。
            </p>
          ) : (
            <table className="w-full text-sm bg-panel-2 rounded-[18px] border border-line overflow-hidden">
              <thead className="bg-panel text-left text-t2">
                <tr>
                  <th className="px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">版本</th>
                  <th className="px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">狀態</th>
                  <th className="px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">建立者</th>
                  <th className="px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">發佈時間</th>
                  <th className="px-4 py-2.5 text-right text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className="border-b border-line last:border-0 hover:bg-black/[.04]">
                    <td className="px-4 py-2 font-mono">
                      v{v.version}
                      {v.status === "ACTIVE" ? <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-full bg-ok text-panel font-semibold">ACTIVE</span> : null}
                    </td>
                    <td className="px-4 py-2 text-t2">{v.status}</td>
                    <td className="px-4 py-2 text-t3 font-mono text-xs">{v.createdBy ?? "—"}</td>
                    <td className="px-4 py-2 text-t2">{fmtDate(v.publishedAt)}</td>
                    <td className="px-4 py-2 text-right">
                      {v.status === "ACTIVE" ? (
                        <span className="text-xs text-t3">—</span>
                      ) : (
                        <button
                          onClick={() => doRevert(v)}
                          disabled={busy}
                          className="text-xs px-2.5 py-1 rounded-full border border-line bg-panel hover:border-brand text-t1 disabled:opacity-40"
                        >
                          回退到此版（→ v{maxVersion + 1}）
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </div>
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────
export default function WorkflowsAdmin() {
  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [versions, setVersions] = useState<Record<string, VersionRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = clinicId ? `?clinicId=${encodeURIComponent(clinicId)}` : "";
      const [wfRes, ...verRes] = await Promise.all([
        api<{ workflows: WorkflowInfo[] }>(`/api/admin/workflows${qs}`),
        ...wfResSafe(["triage", "booking-session", "reminder"], (k) =>
          api<{ versions: VersionRow[] }>(`/api/admin/workflows/${k}/versions${qs}`)
        ),
      ]);
      setWorkflows(wfRes.workflows);
      const vm: Record<string, VersionRow[]> = {};
      ["triage", "booking-session", "reminder"].forEach((k, i) => {
        vm[k] = verRes[i].versions;
      });
      setVersions(vm);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [clinicId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<ClinicRow[]>("/api/admin/clinics").then((r) => setClinics(r)).catch(() => undefined);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-t1">Workflow 參數</h1>
        <div className="flex items-center gap-2">
          <label className="text-sm text-t2">作用範圍</label>
          <select
            value={clinicId ?? ""}
            onChange={(e) => setClinicId(e.target.value || null)}
            className="text-sm bg-panel border border-line rounded-full px-3 py-2 text-t1"
          >
            <option value="">全局（default）</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? <p className="text-sm text-danger-text">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-t2">載入中…</p>
      ) : (
        workflows.map((wf) => (
          <KeyCard key={wf.key} wf={wf} clinicId={clinicId} versions={versions[wf.key] ?? []} onChanged={load} />
        ))
      )}
    </div>
  );
}

/** Promise.all 用嘅 key 列表 helper（避免 Promise.all 型別展開痛）。 */
function wfResSafe<T>(keys: string[], fn: (k: string) => Promise<T>): Promise<T>[] {
  return keys.map(fn);
}
