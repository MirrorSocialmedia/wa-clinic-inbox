"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 診所 CRUD client — 列表 + 建立/編輯（含 greetingConfig JSON 編輯器）+ 刪除。
 * 所有 mutation 經 /api/admin/clinics（ADMIN-only）。
 */
interface Clinic {
  id: string;
  code: string;
  name: string;
  waPhoneNumberId: string;
  waDisplayNumber: string;
  apricotClinicId: string | null;
  greetingConfig: Record<string, unknown> | null;
  aiMode: "DRAFT" | "AUTO";
  conversationCount: number;
  contactCount: number;
}

interface FormState {
  code: string;
  name: string;
  waPhoneNumberId: string;
  waDisplayNumber: string;
  greetingConfig: string; // JSON 文字（編輯器）
}

const emptyForm: FormState = {
  code: "",
  name: "",
  waPhoneNumberId: "",
  waDisplayNumber: "",
  greetingConfig: "",
};

function toForm(c: Clinic): FormState {
  return {
    code: c.code,
    name: c.name,
    waPhoneNumberId: c.waPhoneNumberId,
    waDisplayNumber: c.waDisplayNumber,
    greetingConfig: c.greetingConfig ? JSON.stringify(c.greetingConfig, null, 2) : "",
  };
}

export default function ClinicsAdmin() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Clinic | null>(null); // null=關閉, undefined 以外
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/clinics", { cache: "no-store" });
    if (res.ok) setClinics((await res.json()) as Clinic[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setForm(emptyForm);
    setJsonError(null);
    setError(null);
    setCreating(true);
    setEditing(null);
  }

  function openEdit(c: Clinic) {
    setForm(toForm(c));
    setJsonError(null);
    setError(null);
    setEditing(c);
    setCreating(false);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
  }

  function setGreeting(text: string) {
    setForm((f) => ({ ...f, greetingConfig: text }));
    setJsonError(null);
    if (!text.trim()) return;
    try {
      const v = JSON.parse(text);
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        setJsonError("必須係 JSON object（例如 { \"address\": \"...\" }）");
      }
    } catch {
      setJsonError("JSON 格式錯誤");
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let greetingConfig: unknown = null;
      if (form.greetingConfig.trim()) {
        greetingConfig = JSON.parse(form.greetingConfig);
      }
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        waPhoneNumberId: form.waPhoneNumberId.trim(),
        waDisplayNumber: form.waDisplayNumber.trim(),
        greetingConfig,
      };
      const res = editing
        ? await fetch(`/api/admin/clinics/${editing.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/clinics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; detail?: unknown; issues?: { path: string; message: string }[] }
        | null;
      if (!res.ok) {
        setError(
          body?.issues
            ? body.issues.map((i) => `${i.path}: ${i.message}`).join("；")
            : (body?.error ?? `HTTP ${res.status}`)
        );
        return;
      }
      closeForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Clinic) {
    if (!confirm(`確定刪除 ${c.code}？（有對話/聯絡人/員工嘅店會先擋住）`)) return;
    const res = await fetch(`/api/admin/clinics/${c.id}`, { method: "DELETE" });
    const body = (await res.json().catch(() => null)) as
      | { error?: string; hint?: string; detail?: Record<string, number> }
      | null;
    if (!res.ok) {
      alert(`${body?.error ?? `HTTP ${res.status}`}\n${body?.hint ?? ""}`);
      return;
    }
    await load();
  }

  // Phase 2b：逐舖 AI 模式切換（DRAFT ↔ AUTO）。AUTO 要有醒目提示 + 二次確認。
  async function setAiMode(c: Clinic) {
    const next: "DRAFT" | "AUTO" = c.aiMode === "DRAFT" ? "AUTO" : "DRAFT";
    const ok =
      next === "AUTO"
        ? confirm(
            `⚠️ 即將為 ${c.code} 開啟 AUTO 模式

開啟後：AI 回覆會直接覆病人（唔經 staff 人手確認）。
例外（永遠唔會自動發，退回 staff 處理）：
・急症（URGENT_PAIN / HIGH）
・要求人工（needsHuman）
・超出 24 小時客服窗口

確定為 ${c.code} 開啟 AUTO？`
          )
        : confirm(`確定將 ${c.code} 轉回 DRAFT 模式？（AI 只出建議，staff 採用先發）`);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/clinics/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiMode: next }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        alert(`${body?.error ?? `HTTP ${res.status}`}`);
        return;
      }
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "切換失敗");
    } finally {
      setBusy(false);
    }
  }

  const input =
    "mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
  const label = "block text-sm text-neutral-700";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-neutral-900">診所管理</h1>
        <button
          onClick={openCreate}
          className="rounded-md bg-blue-600 text-white text-sm px-4 py-2 hover:bg-blue-700"
        >
          + 新增診所
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">載入中…</p>
      ) : (
        <table className="w-full text-sm bg-white rounded-lg border border-neutral-200 overflow-hidden">
          <thead className="bg-neutral-100 text-left text-neutral-600">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">名稱</th>
              <th className="px-4 py-2">Phone Number ID</th>
              <th className="px-4 py-2">顯示號碼</th>
              <th className="px-4 py-2">對話 / 聯絡人</th>
              <th className="px-4 py-2">AI 模式</th>
              <th className="px-4 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {clinics.map((c) => (
              <tr key={c.id} className="border-t border-neutral-100">
                <td className="px-4 py-2 font-mono">{c.code}</td>
                <td className="px-4 py-2">{c.name}</td>
                <td className="px-4 py-2 font-mono text-xs">{c.waPhoneNumberId}</td>
                <td className="px-4 py-2">{c.waDisplayNumber}</td>
                <td className="px-4 py-2">
                  {c.conversationCount} / {c.contactCount}
                </td>
                <td className="px-4 py-2">
                  {c.aiMode === "AUTO" ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 border border-amber-300 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                      ⚡ AUTO
                      <span className="font-normal text-amber-700">AI 會直接覆病人</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-neutral-100 border border-neutral-300 px-2.5 py-0.5 text-xs font-medium text-neutral-700">
                      ✏️ DRAFT（預設）
                    </span>
                  )}
                  <button
                    onClick={() => void setAiMode(c)}
                    disabled={busy}
                    className={`ml-2 text-xs hover:underline disabled:opacity-50 ${
                      c.aiMode === "DRAFT" ? "text-amber-700" : "text-neutral-600"
                    }`}
                  >
                    {c.aiMode === "DRAFT" ? "開 AUTO →" : "轉 DRAFT"}
                  </button>
                </td>
                <td className="px-4 py-2 text-right space-x-3">
                  <button onClick={() => openEdit(c)} className="text-blue-600 hover:underline">
                    編輯
                  </button>
                  <button onClick={() => remove(c)} className="text-red-600 hover:underline">
                    刪除
                  </button>
                </td>
              </tr>
            ))}
            {clinics.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-neutral-500">
                  未設診所
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {(creating || editing) && (
        <div className="bg-white rounded-lg border border-neutral-200 p-6 space-y-4 max-w-2xl">
          <h2 className="font-medium text-neutral-900">{creating ? "新增診所" : `編輯 ${editing?.code}`}</h2>
          <div className="grid grid-cols-2 gap-4">
            <label className={label}>
              Code（同 clinic-workforce 一致）
              <input className={input} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </label>
            <label className={label}>
              名稱
              <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className={label}>
              waPhoneNumberId（Meta，分流 key）
              <input
                className={`${input} font-mono`}
                value={form.waPhoneNumberId}
                onChange={(e) => setForm({ ...form, waPhoneNumberId: e.target.value })}
              />
            </label>
            <label className={label}>
              顯示號碼
              <input
                className={input}
                value={form.waDisplayNumber}
                onChange={(e) => setForm({ ...form, waDisplayNumber: e.target.value })}
              />
            </label>
          </div>
          <label className="block text-sm text-neutral-700">
            greetingConfig（JSON — 地址/營業時間/醫生/FAQ，餵 AI 草稿用）
            <textarea
              className={`${input} font-mono text-xs h-40 mt-1`}
              value={form.greetingConfig}
              onChange={(e) => setGreeting(e.target.value)}
              placeholder='{"address": "...", "openingHours": "...", "doctors": [...], "faq": [...]}'
            />
          </label>
          {jsonError && <p className="text-sm text-red-600">{jsonError}</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded-md bg-blue-600 text-white text-sm px-4 py-2 hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button onClick={closeForm} className="rounded-md border border-neutral-300 text-sm px-4 py-2">
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
