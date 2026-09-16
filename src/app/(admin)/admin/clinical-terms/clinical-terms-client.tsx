"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";

/**
 * 術語對照表 client — cwi-followup-p4-20260916 S6（MD §5.3）。
 * 零技術詞：「速記 → 標準名稱 · 用喺」；解析規則唔可編輯（只詞表可改）。
 * usedFor 顯示名映射：after_treatment 術後關懷 / quote_extraction 報價抽取 / recall 定期召回。
 */
interface Term {
  id: string;
  shorthand: string;
  nameCn: string;
  nameEn: string | null;
  usedFor: string[];
  active: boolean;
  updatedAt: string;
}

const USED_FOR_LABEL: Record<string, string> = {
  after_treatment: "術後關懷",
  quote_extraction: "報價抽取",
  recall: "定期召回",
};
const USED_FOR_KEYS = Object.keys(USED_FOR_LABEL);

export default function ClinicalTerms() {
  const [terms, setTerms] = useState<Term[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [newShorthand, setNewShorthand] = useState("");
  const [newNameCn, setNewNameCn] = useState("");
  const [newNameEn, setNewNameEn] = useState("");
  const [newUsedFor, setNewUsedFor] = useState<string[]>(["quote_extraction"]);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/clinical-terms", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { terms: Term[] };
      setTerms(j.terms);
      setLoadErr(null);
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (id: string, p: Partial<Term>) => {
    setTerms((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
    setDirty(true);
    setSavedMsg(null);
  };
  const remove = (id: string) => {
    setTerms((ts) => ts.filter((t) => t.id !== id));
    setDirty(true);
    setSavedMsg(null);
  };
  const addTerm = () => {
    const sh = newShorthand.trim();
    const cn = newNameCn.trim();
    if (!sh || !cn) return;
    if (terms.some((t) => t.shorthand.toLowerCase() === sh.toLowerCase())) {
      setSaveErr(`速記「${sh}」已經存在`);
      return;
    }
    setTerms((ts) => [
      ...ts,
      { id: `new-${Date.now()}`, shorthand: sh, nameCn: cn, nameEn: newNameEn.trim() || null, usedFor: newUsedFor, active: true, updatedAt: "" },
    ]);
    setNewShorthand("");
    setNewNameCn("");
    setNewNameEn("");
    setSaveErr(null);
    setDirty(true);
  };
  const toggleUsedFor = (t: Term, key: string) => {
    const has = t.usedFor.includes(key);
    patch(t.id, { usedFor: has ? t.usedFor.filter((k) => k !== key) : [...t.usedFor, key] });
  };

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    setSavedMsg(null);
    try {
      const res = await fetch("/api/admin/clinical-terms", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          terms: terms.map((t) => ({ shorthand: t.shorthand, nameCn: t.nameCn, nameEn: t.nameEn, usedFor: t.usedFor, active: t.active })),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { terms: Term[] };
      setTerms(j.terms);
      setDirty(false);
      setSavedMsg("已儲存 — 新詞即時生效");
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4" data-e2e="ct-root">
      <div>
        <h1 className="text-lg font-semibold text-t1">術語對照表</h1>
        <p className="text-[12px] text-t3 mt-1">
          速記 → 標準名稱 · 用喺。醫師／護士可以加減詞；解析規則（牙位、金額、否定詞）唔可編輯，只有詞表可改。
        </p>
      </div>

      {loading ? (
        <div className="text-[13px] text-t3 py-8 text-center">載入中…</div>
      ) : loadErr ? (
        <div className="bg-danger-soft text-danger-text text-[13px] rounded-xl p-3" data-e2e="ct-err">載入失敗：{loadErr}</div>
      ) : (
        <div className="bg-panel border border-line rounded-xl overflow-hidden" data-e2e="ct-table">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-t3 border-b border-line">
                <th className="px-3 py-2 font-medium w-28">速記</th>
                <th className="px-3 py-2 font-medium">標準名稱</th>
                <th className="px-3 py-2 font-medium">英文名（選填）</th>
                <th className="px-3 py-2 font-medium">用喺</th>
                <th className="px-3 py-2 font-medium w-16">啟用</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {terms.map((t) => (
                <tr key={t.id} className={`border-b border-line last:border-0 ${t.active ? "" : "opacity-50"}`} data-e2e={`ct-row-${t.shorthand}`}>
                  <td className="px-3 py-2 font-mono text-t1 whitespace-nowrap">{t.shorthand}</td>
                  <td className="px-3 py-2">
                    <input
                      className="w-full bg-transparent border border-transparent hover:border-line focus:border-brand focus:outline-none rounded px-1.5 py-0.5 text-t1"
                      value={t.nameCn}
                      onChange={(e) => patch(t.id, { nameCn: e.target.value })}
                      data-e2e={`ct-namecn-${t.shorthand}`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="w-full bg-transparent border border-transparent hover:border-line focus:border-brand focus:outline-none rounded px-1.5 py-0.5 text-t2"
                      value={t.nameEn ?? ""}
                      placeholder="—"
                      onChange={(e) => patch(t.id, { nameEn: e.target.value || null })}
                      data-e2e={`ct-nameen-${t.shorthand}`}
                    />
                  </td>
                  <td className="px-3 py-2 space-x-2 whitespace-nowrap">
                    {USED_FOR_KEYS.map((k) => (
                      <label key={k} className="inline-flex items-center gap-1 text-t2 cursor-pointer">
                        <input type="checkbox" checked={t.usedFor.includes(k)} onChange={() => toggleUsedFor(t, k)} className="accent-brand" />
                        {USED_FOR_LABEL[k]}
                      </label>
                    ))}
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={t.active} onChange={(e) => patch(t.id, { active: e.target.checked })} className="accent-brand" data-e2e={`ct-active-${t.shorthand}`} />
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => remove(t.id)} className="text-t3 hover:text-danger-text" title="移除" data-e2e={`ct-del-${t.shorthand}`}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {terms.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-t3 text-[13px]">
                    尚未有術語 — 喺下面加第一條
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 加一個 */}
      <div className="bg-panel border border-dashed border-line rounded-xl p-3 space-y-2" data-e2e="ct-add">
        <div className="flex items-center gap-2 text-[12px] text-t3">
          <Plus size={14} /> 加一個術語
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            className="bg-panel-2 border border-line rounded-lg px-2.5 py-1.5 text-[13px] text-t1 w-32 focus:outline-none focus:border-brand"
            placeholder="速記（如 x）"
            value={newShorthand}
            onChange={(e) => setNewShorthand(e.target.value)}
            data-e2e="ct-new-shorthand"
          />
          <input
            className="bg-panel-2 border border-line rounded-lg px-2.5 py-1.5 text-[13px] text-t1 w-44 focus:outline-none focus:border-brand"
            placeholder="標準名稱（如 拔牙）"
            value={newNameCn}
            onChange={(e) => setNewNameCn(e.target.value)}
            data-e2e="ct-new-namecn"
          />
          <input
            className="bg-panel-2 border border-line rounded-lg px-2.5 py-1.5 text-[13px] text-t1 w-40 focus:outline-none focus:border-brand"
            placeholder="英文名（選填）"
            value={newNameEn}
            onChange={(e) => setNewNameEn(e.target.value)}
            data-e2e="ct-new-nameen"
          />
          <button
            onClick={addTerm}
            disabled={!newShorthand.trim() || !newNameCn.trim()}
            className="bg-panel-2 border border-line rounded-lg px-3 py-1.5 text-[13px] text-t1 hover:bg-panel-3 disabled:opacity-40"
            data-e2e="ct-new-add"
          >
            加入
          </button>
        </div>
        <div className="flex gap-3">
          {USED_FOR_KEYS.map((k) => (
            <label key={k} className="inline-flex items-center gap-1 text-[12px] text-t2 cursor-pointer">
              <input
                type="checkbox"
                checked={newUsedFor.includes(k)}
                onChange={() => setNewUsedFor((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]))}
                className="accent-brand"
              />
              {USED_FOR_LABEL[k]}
            </label>
          ))}
        </div>
      </div>

      {/* 狀態 + 儲存 */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px]">
          {saveErr ? (
            <span className="text-danger-text" data-e2e="ct-save-err">{saveErr}</span>
          ) : savedMsg ? (
            <span className="text-ok-text" data-e2e="ct-saved">{savedMsg}</span>
          ) : (
            <span className="text-t3">{dirty ? "有未儲存改動" : ""}</span>
          )}
        </div>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 bg-brand text-white rounded-lg px-4 py-2 text-[13px] font-medium hover:opacity-90 disabled:opacity-40"
          data-e2e="ct-save"
        >
          <Save size={14} /> {saving ? "儲存中…" : "儲存改動"}
        </button>
      </div>
    </div>
  );
}
