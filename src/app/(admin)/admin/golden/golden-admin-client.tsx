"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * ★ Part F（cwi-raggolden-20260904，F.5/F.6）GoldenCase 評測集管理 client（ADMIN-only）。
 *
 * - 列表按 source 分組/過濾（HISTORY_SAMPLE 未審核 = enabled:false → 唔入 eval）
 * - 每行：utterance（已 deid）+ contextBefore + 期望（intent/redFlag/autoOk/docIds）+ 來源 badge
 * - 審核：「✓ 收貨」= enabled:true（先收貨先入 eval）／「✎ 改」= 彈窗改期望／「✗ 丟」= enabled:false
 *   （HISTORY_SAMPLE 預設 enabled:false — 未審核唔入 eval；INBOX_BUTTON 預設 true — staff 即時確認過）
 * - 頂部顯示 eval 統計：enabled 總數 / 未審核（sample）數
 */
interface CaseRow {
  id: string;
  clinicId: string | null;
  source: string;
  utterance: string;
  contextBefore: string[];
  expectIntent: string;
  expectRedFlag: boolean;
  expectAutoOk: boolean;
  expectDocIds: string[];
  note: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
}
interface ClinicRow {
  id: string;
  code: string;
  name: string;
}

const INTENTS = ["BOOKING_REQUEST", "QUESTION", "URGENT_PAIN", "COMPLAINT", "OUT_OF_SCOPE", "OTHER"];
const SOURCE_LABEL: Record<string, string> = {
  HISTORY_SAMPLE: "歷史取樣",
  INBOX_BUTTON: "inbox 加入",
  MANUAL: "人手",
};

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

interface FormState {
  id: string;
  expectIntent: string;
  expectRedFlag: boolean;
  expectAutoOk: boolean;
  expectDocIds: string;
  note: string;
}

export default function GoldenAdmin() {
  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [clinicId, setClinicId] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [showUnreviewed, setShowUnreviewed] = useState(false);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (cid: string, src: string) => {
    if (!cid) return;
    setLoading(true);
    setErr(null);
    try {
      const q = new URLSearchParams();
      if (src) q.set("source", src);
      const r = await api<{ cases: CaseRow[] }>(`/api/golden-cases?clinicId=${encodeURIComponent(cid)}&${q.toString()}`);
      setCases(r.cases);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api<ClinicRow[]>("/api/admin/clinics")
      .then((r) => {
        setClinics(r);
        if (r.length > 0 && !clinicId) setClinicId(r[0].id);
      })
      .catch(() => setErr("診所列表載入失敗"));
  }, [clinicId]);

  useEffect(() => {
    if (clinicId) void load(clinicId, source);
  }, [clinicId, source, load]);

  const visible = useMemo(
    () => (showUnreviewed ? cases : cases.filter((c) => c.enabled)),
    [cases, showUnreviewed]
  );
  const unreviewedCount = useMemo(() => cases.filter((c) => c.source === "HISTORY_SAMPLE" && !c.enabled).length, [cases]);

  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      await api(`/api/golden-cases/${id}`, { method: "PUT", body: JSON.stringify(body) });
      await load(clinicId, source);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "update failed");
    }
  };

  const approve = (c: CaseRow) => void patch(c.id, { enabled: true });
  const reject = (c: CaseRow) => void patch(c.id, { enabled: false });
  const discard = async (c: CaseRow) => {
    if (!confirm(`確認刪除呢條 case？\n「${c.utterance.slice(0, 40)}…」`)) return;
    try {
      await api(`/api/golden-cases/${c.id}`, { method: "DELETE" });
      await load(clinicId, source);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    }
  };

  const submit = async () => {
    if (!form) return;
    setFormErr(null);
    setBusy(true);
    try {
      await api(`/api/golden-cases/${form.id}`, {
        method: "PUT",
        body: JSON.stringify({
          expectIntent: form.expectIntent,
          expectRedFlag: form.expectRedFlag,
          expectAutoOk: form.expectAutoOk,
          expectDocIds: form.expectDocIds.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
          note: form.note || null,
        }),
      });
      setForm(null);
      await load(clinicId, source);
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">GoldenCase 評測集</h1>
          <p className="text-sm text-t2 mt-1">
            去識別化測試集（零 PII — 電話→&lt;phone&gt;、姓名→&lt;name&gt;）。<b>只收貨（enabled）嘅 case 先入 eval</b>。
            {unreviewedCount > 0 && <span className="text-warn ml-2">⚠ {unreviewedCount} 條歷史取樣未審核</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={clinicId} onChange={(e) => setClinicId(e.target.value)} className="border rounded-md px-2 py-1.5 text-sm bg-panel">
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} {c.name}
              </option>
            ))}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} className="border rounded-md px-2 py-1.5 text-sm bg-panel">
            <option value="">全部來源</option>
            <option value="HISTORY_SAMPLE">歷史取樣</option>
            <option value="INBOX_BUTTON">inbox 加入</option>
            <option value="MANUAL">人手</option>
          </select>
          <label className="flex items-center gap-1 text-xs text-t2 select-none">
            <input type="checkbox" checked={showUnreviewed} onChange={(e) => setShowUnreviewed(e.target.checked)} />
            顯示未收貨
          </label>
        </div>
      </div>

      {err && <div className="bg-danger-soft text-danger text-sm rounded-md px-3 py-2">{err}</div>}
      {loading && <div className="text-sm text-t2">載入中…</div>}
      {!loading && visible.length === 0 && <div className="text-sm text-t2">（冇 case）</div>}

      {visible.map((c) => (
        <div key={c.id} className={`border rounded-lg bg-panel px-4 py-3 ${c.enabled ? "" : "opacity-70"}`}>
          <div className="text-sm">
            <span className={`inline-block text-[11px] rounded px-1.5 py-0.5 mr-2 ${c.enabled ? "bg-ok-soft text-ok-text" : "bg-line text-t2"}`}>
              {c.enabled ? "收貨（入 eval）" : "未收貨"}
            </span>
            <span className="text-[11px] bg-brand-soft text-brand-text rounded px-1.5 py-0.5 mr-2">{SOURCE_LABEL[c.source] ?? c.source}</span>
            <span className="text-[11px] bg-line text-t2 rounded px-1.5 py-0.5 mr-2">{c.expectIntent}</span>
            {c.expectRedFlag && <span className="text-[11px] bg-danger-soft text-danger rounded px-1.5 py-0.5 mr-2">紅旗</span>}
            {c.expectAutoOk && <span className="text-[11px] bg-ok-soft text-ok-text rounded px-1.5 py-0.5 mr-2">應自動覆</span>}
          </div>
          <div className="mt-1.5 text-sm">{c.utterance}</div>
          {c.contextBefore.length > 0 && (
            <div className="text-xs text-t2 mt-1">前情：{c.contextBefore.join(" ／ ")}</div>
          )}
          {c.expectDocIds.length > 0 && (
            <div className="text-xs text-t2 mt-1">期望引用：{c.expectDocIds.join(", ")}</div>
          )}
          {c.note && <div className="text-xs text-t2 mt-1">備註：{c.note}</div>}
          <div className="flex items-center gap-2 mt-2">
            {!c.enabled && (
              <button onClick={() => approve(c)} className="text-xs bg-ok-soft text-ok-text rounded px-2 py-1 hover:opacity-80">
                ✓ 收貨
              </button>
            )}
            {c.enabled && (
              <button onClick={() => reject(c)} className="text-xs border rounded px-2 py-1 hover:bg-canvas">
                停用（出 eval）
              </button>
            )}
            <button
              onClick={() =>
                setForm({
                  id: c.id,
                  expectIntent: c.expectIntent,
                  expectRedFlag: c.expectRedFlag,
                  expectAutoOk: c.expectAutoOk,
                  expectDocIds: c.expectDocIds.join(", "),
                  note: c.note ?? "",
                })
              }
              className="text-xs border rounded px-2 py-1 hover:bg-canvas"
            >
              ✎ 改
            </button>
            <button onClick={() => discard(c)} className="text-xs border border-danger text-danger rounded px-2 py-1 hover:bg-danger-soft">
              ✗ 丟
            </button>
            <span className="text-[11px] text-t2 ml-auto">
              {new Date(c.createdAt).toLocaleString("zh-HK")}
            </span>
          </div>
        </div>
      ))}

      {form && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-panel rounded-lg w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">修改期望</h2>
              <button onClick={() => setForm(null)} className="text-t2 hover:text-t1">✕</button>
            </div>
            {formErr && <div className="bg-danger-soft text-danger text-xs rounded px-2 py-1.5">{formErr}</div>}
            <label className="block text-xs text-t2">
              正確 intent
              <select value={form.expectIntent} onChange={(e) => setForm({ ...form, expectIntent: e.target.value })} className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel">
                {INTENTS.map((i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.expectRedFlag} onChange={(e) => setForm({ ...form, expectRedFlag: e.target.checked })} />
              應該紅旗（urgency HIGH / 紅旗詞）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.expectAutoOk} onChange={(e) => setForm({ ...form, expectAutoOk: e.target.checked })} />
              應該可自動覆
            </label>
            <label className="block text-xs text-t2">
              期望知識引用 doc id（逗號分隔）
              <input value={form.expectDocIds} onChange={(e) => setForm({ ...form, expectDocIds: e.target.value })} className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel" />
            </label>
            <label className="block text-xs text-t2">
              備註
              <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="mt-1 w-full border rounded px-2 py-1.5 text-sm bg-panel" />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setForm(null)} className="text-sm border rounded px-3 py-1.5 hover:bg-canvas">取消</button>
              <button onClick={submit} disabled={busy} className="text-sm bg-brand text-panel rounded px-3 py-1.5 font-medium disabled:opacity-50">
                {busy ? "儲存中…" : "儲存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
