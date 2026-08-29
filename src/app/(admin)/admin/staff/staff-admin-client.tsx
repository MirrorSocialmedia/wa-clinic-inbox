"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 員工 CRUD client — 列表 + 建立/編輯 + password reset + 停用 + 刪除。
 * 所有 mutation 經 /api/admin/staff（ADMIN-only，含鎖死保護）。
 */
interface Staff {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "STAFF";
  clinicId: string | null;
  clinicCode: string | null;
  active: boolean;
}

interface ClinicOpt {
  id: string;
  code: string;
}

interface FormState {
  email: string;
  name: string;
  role: "ADMIN" | "STAFF";
  clinicId: string; // "" = null（ADMIN 或「未揀」）
  password: string; // 建立時必填；編輯時選填（= reset）
  active: boolean;
}

const emptyForm: FormState = { email: "", name: "", role: "STAFF", clinicId: "", password: "", active: true };

export default function StaffAdmin() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [clinics, setClinics] = useState<ClinicOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      fetch("/api/admin/staff", { cache: "no-store" }),
      fetch("/api/admin/clinics", { cache: "no-store" }),
    ]);
    if (s.ok) setStaff((await s.json()) as Staff[]);
    if (c.ok) setClinics((await c.json()) as ClinicOpt[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setForm(emptyForm);
    setError(null);
    setCreating(true);
    setEditing(null);
  }

  function openEdit(u: Staff) {
    setForm({
      email: u.email,
      name: u.name,
      role: u.role,
      clinicId: u.clinicId ?? "",
      password: "",
      active: u.active,
    });
    setError(null);
    setEditing(u);
    setCreating(false);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const isStaff = form.role === "STAFF";
      const payload = {
        name: form.name.trim(),
        role: form.role,
        clinicId: isStaff ? form.clinicId || null : null,
        active: form.active,
        ...(form.password ? { newPassword: form.password } : {}),
        ...(creating ? { email: form.email.trim(), password: form.password } : {}),
      };
      const res = editing
        ? await fetch(`/api/admin/staff/${editing.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/staff", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; issues?: { path: string; message: string }[] }
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

  async function toggleActive(u: Staff) {
    const res = await fetch(`/api/admin/staff/${u.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !u.active }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      alert(body?.error ?? `HTTP ${res.status}`);
      return;
    }
    await load();
  }

  async function remove(u: Staff) {
    if (!confirm(`確定刪除 ${u.email}？（有發出訊息/負責對話嘅員工會先擋住，建議用停用）`)) return;
    const res = await fetch(`/api/admin/staff/${u.id}`, { method: "DELETE" });
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: unknown } | null;
    if (!res.ok) {
      alert(`${body?.error ?? `HTTP ${res.status}`}${body?.detail ? `\n${JSON.stringify(body.detail)}` : ""}`);
      return;
    }
    await load();
  }

  const input =
    "mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm";
  const label = "block text-sm text-t2";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-t1">員工管理</h1>
        <button
          onClick={openCreate}
          className="rounded-md bg-brand text-white text-sm px-4 py-2 hover:bg-brand-hover"
        >
          + 新增員工
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-t2">載入中…</p>
      ) : (
        <table className="w-full text-sm bg-panel rounded-lg border border-line overflow-hidden">
          <thead className="bg-panel-2 text-left text-t2">
            <tr>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">姓名</th>
              <th className="px-4 py-2">角色</th>
              <th className="px-4 py-2">診所</th>
              <th className="px-4 py-2">狀態</th>
              <th className="px-4 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((u) => (
              <tr key={u.id} className="border-t border-line">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">{u.name}</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      u.role === "ADMIN"
                        ? "px-2 py-0.5 rounded text-xs bg-brand-soft text-brand-text"
                        : "px-2 py-0.5 rounded text-xs bg-panel-2 text-t2"
                    }
                  >
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-xs">{u.clinicCode ?? "—（跨店）"}</td>
                <td className="px-4 py-2">
                  {u.active ? (
                    <span className="text-ok-text">active</span>
                  ) : (
                    <span className="text-t3">停用</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right space-x-3">
                  <button onClick={() => openEdit(u)} className="text-brand-text hover:underline">
                    編輯
                  </button>
                  <button onClick={() => void toggleActive(u)} className="text-warn-text hover:underline">
                    {u.active ? "停用" : "啟用"}
                  </button>
                  <button onClick={() => void remove(u)} className="text-danger-text hover:underline">
                    刪除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(creating || editing) && (
        <div className="bg-panel rounded-lg border border-line p-6 space-y-4 max-w-2xl">
          <h2 className="font-medium text-t1">
            {creating ? "新增員工" : `編輯 ${editing?.email}`}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <label className={label}>
              Email
              <input
                className={input}
                value={form.email}
                disabled={!creating}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label className={label}>
              姓名
              <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className={label}>
              角色
              <select
                className={input}
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as "ADMIN" | "STAFF" })}
              >
                <option value="STAFF">STAFF（單店）</option>
                <option value="ADMIN">ADMIN（跨店）</option>
              </select>
            </label>
            {form.role === "STAFF" ? (
              <label className={label}>
                診所（STAFF 必填）
                <select
                  className={input}
                  value={form.clinicId}
                  onChange={(e) => setForm({ ...form, clinicId: e.target.value })}
                >
                  <option value="">— 揀診所 —</option>
                  {clinics.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className={label}>
              密碼{creating ? "（必填）" : "（留空 = 唔改；填寫 = reset）"}
              <input
                type="password"
                className={input}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete="new-password"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-t2 mt-6">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              active（啟用）
            </label>
          </div>
          {error && <p className="text-sm text-danger-text">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded-md bg-brand text-white text-sm px-4 py-2 hover:bg-brand-hover disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button onClick={closeForm} className="rounded-md border border-line-strong text-sm px-4 py-2">
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
