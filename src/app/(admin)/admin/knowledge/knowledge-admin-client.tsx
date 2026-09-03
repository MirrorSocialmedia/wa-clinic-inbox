"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * ★ Part F（cwi-raggolden-20260904，F.2）知識庫管理 client（ADMIN-only）。
 *
 * 跟 (admin) 現有卡片風（workflows/automation 同款）。
 * - 列表按 kind 分組（SERVICE/POST_OP/POLICY/PRICE/PREP/FAQ）+ 每行 enabled 開關 + 編輯 + 刪
 * - 「預覽目錄」= worker stage 1 prompt 入嘅同一字串（同源 getKnowledgeCatalog — 有 5min cache）
 *   + 字數 + est. token 數（>2500 字警示 — R-3）
 * - 新增/編輯彈窗：kind=title/keywords/body + PRICE 必填 disclaimer（≥8）+ priceMin/Max（min<=max — R-2）
 *
 * 知識庫 = staff 管嘅參數：改即刻生效（local + CONTROL_CHANNEL cache bust）+ AuditLog 審計。
 * R-8 鐵律提示放喺表頭（時段/醫生/病人記錄唔准入知識庫）。
 */
interface DocRow {
  id: string;
  clinicId: string | null;
  kind: string;
  title: string;
  keywords: string[];
  body: string;
  disclaimer: string | null;
  priceMin: number | null;
  priceMax: number | null;
  enabled: boolean;
  version: number;
  updatedBy: string | null;
  updatedAt: string;
}
interface ClinicRow {
  id: string;
  code: string;
  name: string;
}
interface Preview {
  text: string;
  charCount: number;
  estTokens: number;
  docCount: number;
}

const KINDS: { key: string; label: string; hint: string }[] = [
  { key: "SERVICE", label: "服務項目", hint: "係咩/幾多次/幾耐/痛唔痛" },
  { key: "POST_OP", label: "術後護理", hint: "術後注意/康復期" },
  { key: "PRICE", label: "收費範圍", hint: "disclaimer 必填 ≥8 字；priceMin ≤ priceMax" },
  { key: "PREP", label: "到診準備", hint: "帶咩嚟/初診須知" },
  { key: "POLICY", label: "診所政策", hint: "改期/付款/保險（唔寫實際時間）" },
  { key: "FAQ", label: "其他常見問題", hint: "其他" },
];

const KIND_ORDER = ["SERVICE", "POST_OP", "PRICE", "PREP", "POLICY", "FAQ"];

function api<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...init,
  }).then(async (r) => {
    const j = (await r.json().catch(() => ({}))) as T & { error?: string; issues?: { path: string[]; message: string }[] };
    if (!r.ok) throw new Error(j.issues?.map((i) => `${i.path.join(".")}: ${i.message}`).join("；") || j.error || `HTTP ${r.status}`);
    return j;
  });
}

/** 表單狀態（新增/編輯共用）— clinicId null = 全局條目。 */
interface FormState {
  id: string | null;
  clinicId: string;
  global: boolean;
  kind: string;
  title: string;
  keywords: string;
  body: string;
  disclaimer: string;
  priceMin: string;
  priceMax: string;
  enabled: boolean;
}
const emptyForm = (clinicId: string): FormState => ({
  id: null,
  clinicId,
  global: false,
  kind: "SERVICE",
  title: "",
  keywords: "",
  body: "",
  disclaimer: "",
  priceMin: "",
  priceMax: "",
  enabled: true,
});

export default function KnowledgeAdmin() {
  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [clinicId, setClinicId] = useState<string>("");
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (cid: string) => {
    if (!cid) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api<{ docs: DocRow[]; preview: Preview | null }>(`/api/admin/knowledge?clinicId=${encodeURIComponent(cid)}`);
      setDocs(r.docs);
      setPreview(r.preview);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api<ClinicRow[]>("/api/admin/clinics").then((r) => {
      setClinics(r);
      if (r.length > 0 && !clinicId) setClinicId(r[0].id);
    }).catch(() => setErr("診所列表載入失敗"));
  }, [clinicId]);

  useEffect(() => {
    if (clinicId) void load(clinicId);
  }, [clinicId, load]);

  const grouped = useMemo(() => {
    const g: Record<string, DocRow[]> = {};
    for (const d of docs) (g[d.kind] ??= []).push(d);
    return g;
  }, [docs]);

  const submit = async () => {
    if (!form) return;
    setFormErr(null);
    const keywords = form.keywords.split(/[,，/、]/).map((s) => s.trim()).filter(Boolean);
    const body: Record<string, unknown> = {
      clinicId: form.global ? null : form.clinicId,
      kind: form.kind,
      title: form.title.trim(),
      keywords,
      body: form.body.trim(),
      disclaimer: form.kind === "PRICE" ? form.disclaimer.trim() : null,
      priceMin: form.kind === "PRICE" ? Number(form.priceMin) : null,
      priceMax: form.kind === "PRICE" ? Number(form.priceMax) : null,
      enabled: form.enabled,
    };
    // client-side 預檢（server zod 係最後一道）
    if (!body.title) return setFormErr("title 必填");
    if (keywords.length === 0) return setFormErr("keywords 必填（逗號分隔）");
    if (form.kind === "PRICE") {
      const dis = String(body.disclaimer ?? "");
      if (dis.length < 8) return setFormErr("PRICE 條目 disclaimer 必填（≥8 字）");
      if (!Number.isFinite(Number(form.priceMin)) || !Number.isFinite(Number(form.priceMax)))
        return setFormErr("PRICE 條目 priceMin/priceMax 必填");
      if (Number(form.priceMin) > Number(form.priceMax)) return setFormErr("priceMin 必須 ≤ priceMax");
    }
    setBusy(true);
    try {
      if (form.id) {
        await api(`/api/admin/knowledge/${form.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/api/admin/knowledge", { method: "POST", body: JSON.stringify(body) });
      }
      setForm(null);
      await load(clinicId);
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (d: DocRow, enabled: boolean) => {
    try {
      await api(`/api/admin/knowledge/${d.id}`, {
        method: "PUT",
        body: JSON.stringify({
          clinicId: d.clinicId,
          kind: d.kind,
          title: d.title,
          keywords: d.keywords,
          body: d.body,
          disclaimer: d.disclaimer,
          priceMin: d.priceMin,
          priceMax: d.priceMax,
          enabled,
        }),
      });
      await load(clinicId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "toggle failed");
    }
  };

  const remove = async (d: DocRow) => {
    if (!confirm(`確認刪除「${d.title}」？（AuditLog 留痕可 rollback）`)) return;
    try {
      await api(`/api/admin/knowledge/${d.id}`, { method: "DELETE" });
      await load(clinicId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    }
  };

  const openEdit = (d: DocRow) =>
    setForm({
      id: d.id,
      clinicId: d.clinicId ?? clinicId,
      global: d.clinicId === null,
      kind: d.kind,
      title: d.title,
      keywords: d.keywords.join(", "),
      body: d.body,
      disclaimer: d.disclaimer ?? "",
      priceMin: d.priceMin !== null ? String(d.priceMin) : "",
      priceMax: d.priceMax !== null ? String(d.priceMax) : "",
      enabled: d.enabled,
    });

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">知識庫（RAG）</h1>
          <p className="text-sm text-t2 mt-1">
            AI 唔教醫病，只教：邊度睇／幾錢（透明範圍）／點準備。知識庫係 staff 管嘅參數 — 改即刻生效、可審計、可 rollback。
            <span className="text-danger ml-2">R-8：時段／醫生／病人記錄唔准入知識庫。</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={clinicId}
            onChange={(e) => setClinicId(e.target.value)}
            className="border rounded-md px-2 py-1.5 text-sm bg-panel"
          >
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setForm(emptyForm(clinicId))}
            className="bg-brand text-panel rounded-md px-3 py-1.5 text-sm font-medium hover:opacity-90"
          >
            ＋ 新增條目
          </button>
        </div>
      </div>

      {err && <div className="bg-danger-soft text-danger text-sm rounded-md px-3 py-2">{err}</div>}

      {/* 預覽目錄 — worker stage 1 prompt 入嘅同一字串（同源 cache 5min） */}
      <div className="border rounded-lg bg-panel">
        <button
          onClick={() => setPreviewOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
        >
          <span>👁 預覽目錄（AI 選條目用嘅 prompt 段）</span>
          {preview && (
            <span className="text-xs text-t2">
              {preview.docCount} 條 ／ {preview.charCount} 字 ／ ≈{preview.estTokens} tokens
              {preview.charCount > 2500 && <span className="text-danger ml-2">⚠ 超 2500 字</span>}
            </span>
          )}
        </button>
        {previewOpen && (
          <pre className="px-4 pb-4 text-xs leading-5 whitespace-pre-wrap border-t pt-3 max-h-64 overflow-auto">
            {preview?.text || "（目錄空 — 該店 + 全局冇 enabled 條目）"}
          </pre>
        )}
      </div>

      {loading && <div className="text-sm text-t2">載入中…</div>}

      {/* 列表按 kind 分組 */}
      {KIND_ORDER.map((k) => {
        const rows = grouped[k] ?? [];
        const meta = KINDS.find((x) => x.key === k)!;
        return (
          <div key={k} className="border rounded-lg bg-panel">
            <div className="px-4 py-2.5 flex items-center justify-between border-b">
              <div className="text-sm font-semibold">
                {meta.label} <span className="text-t2 font-normal">({k} × {rows.length})</span>
                <span className="text-xs text-t2 ml-2">{meta.hint}</span>
              </div>
            </div>
            {rows.length === 0 && <div className="px-4 py-3 text-sm text-t2">（空）</div>}
            {rows.map((d) => (
              <div key={d.id} className="px-4 py-2.5 border-b last:border-b-0 text-sm flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-medium ${d.enabled ? "" : "line-through text-t2"}`}>{d.title}</span>
                    <span className="text-[11px] text-t2">
                      {d.clinicId === null ? "全局" : "本店"} v{d.version}
                    </span>
                    {d.kind === "PRICE" && d.priceMin !== null && (
                      <span className="text-[11px] bg-brand-soft text-brand-text rounded px-1.5 py-0.5">
                        ${d.priceMin}–${d.priceMax}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-t2 truncate">{d.keywords.join(" / ")}</div>
                </div>
                <label className="flex items-center gap-1 text-xs text-t2 select-none">
                  <input type="checkbox" checked={d.enabled} onChange={(e) => toggle(d, e.target.checked)} />
                  啟用
                </label>
                <button onClick={() => openEdit(d)} className="text-xs border rounded px-2 py-1 hover:bg-canvas">
                  編輯
                </button>
                <button onClick={() => remove(d)} className="text-xs border border-danger text-danger rounded px-2 py-1 hover:bg-danger-soft">
                  刪
                </button>
              </div>
            ))}
          </div>
        );
      })}

      {/* 新增/編輯彈窗 */}
      {form && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-panel rounded-lg w-full max-w-lg max-h-[85vh] overflow-auto p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{form.id ? "編輯條目" : "新增條目"}</h2>
              <button onClick={() => setForm(null)} className="text-t2 hover:text-t1">
                ✕
              </button>
            </div>
            {formErr && <div className="bg-danger-soft text-danger text-xs rounded px-2 py-1.5">{formErr}</div>}
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-t2">
                適用
                <select
                  value={form.global ? "global" : "clinic"}
                  onChange={(e) => setForm({ ...form, global: e.target.value === "global" })}
                  className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                >
                  <option value="clinic">本店（覆寫/補充）</option>
                  <option value="global">全局（所有店）</option>
                </select>
              </label>
              <label className="text-xs text-t2">
                種類
                <select
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                  className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                >
                  {KINDS.map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.label}（{k.key}）
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-xs text-t2">
              標題（進目錄，要夠精準）
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                placeholder="例：洗牙"
              />
            </label>
            <label className="block text-xs text-t2">
              Keywords（口語+書面，逗號分隔）
              <input
                value={form.keywords}
                onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                placeholder="洗牙, 潔牙, 洗牙石, scale"
              />
            </label>
            <label className="block text-xs text-t2">
              正文（≤600 字；超長拆條）
              <textarea
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={5}
                className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
              />
            </label>
            {form.kind === "PRICE" && (
              <div className="grid grid-cols-2 gap-3 border border-brand rounded-md p-2.5 bg-brand-soft">
                <label className="text-xs text-t2 col-span-2">
                  Disclaimer（必填 ≥8 字 — 系統會強制附加落報價草稿）
                  <input
                    value={form.disclaimer}
                    onChange={(e) => setForm({ ...form, disclaimer: e.target.value })}
                    className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                    placeholder="以上為參考收費範圍，實際費用以到診評估為準"
                  />
                </label>
                <label className="text-xs text-t2">
                  價格下限
                  <input
                    value={form.priceMin}
                    onChange={(e) => setForm({ ...form, priceMin: e.target.value })}
                    className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                    inputMode="numeric"
                  />
                </label>
                <label className="text-xs text-t2">
                  價格上限
                  <input
                    value={form.priceMax}
                    onChange={(e) => setForm({ ...form, priceMax: e.target.value })}
                    className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel"
                    inputMode="numeric"
                  />
                </label>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              啟用
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setForm(null)} className="text-sm border rounded px-3 py-1.5 hover:bg-canvas">
                取消
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="text-sm bg-brand text-panel rounded px-3 py-1.5 font-medium disabled:opacity-50"
              >
                {busy ? "儲存中…" : "儲存（即刻生效）"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
