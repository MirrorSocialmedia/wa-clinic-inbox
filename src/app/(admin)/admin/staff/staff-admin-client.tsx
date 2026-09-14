"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 員工 CRUD client — 列表 + 建立/編輯 + password reset + 停用 + 刪除。
 * 所有 mutation 經 /api/admin/staff（ADMIN-only，含鎖死保護）。
 *
 * ★ cwi-hub-a-20260914（Part A / MD A.3）：公司層範圍
 *   表單順序：Email → 姓名 → 角色（ADMIN/STAFF/SUPERVISOR）→ 範圍三 chip（全集團/某公司/指定診所）→ 對應選擇器。
 *   列表「診所」欄：`全集團` / `A 菁薈（1）`（公司 code+名+店數）/ `TY, TKW`（指定診所 codes）。
 */
type Role = "ADMIN" | "STAFF" | "SUPERVISOR";
type ScopeType = "ALL" | "COMPANY" | "CLINICS";

interface Staff {
  id: string;
  email: string;
  name: string;
  role: Role;
  clinicId: string | null;
  clinicCode: string | null;
  active: boolean;
  // ★ cwi-hub-a scope 摘要（server 算好）
  scopeType: ScopeType;
  scopeCompanyId: string | null;
  companyCode: string | null;
  companyName: string | null;
  companyClinicCount: number | null;
  clinicIds: string[];
  clinicCodes: string[];
}

interface ClinicOpt {
  id: string;
  code: string;
}

interface CompanyOpt {
  id: string;
  code: string;
  name: string;
  clinics: { id: string; code: string; name: string }[];
}

interface FormState {
  email: string;
  name: string;
  role: Role;
  scopeType: ScopeType;
  scopeCompanyId: string; // "" = 未揀（COMPANY 模式必填）
  clinicIds: string[]; // CLINICS 模式（可跨公司）
  password: string; // 建立時必填；編輯時選填（= reset）
  active: boolean;
}

const defaultScopeFor = (role: Role): ScopeType => (role === "STAFF" ? "CLINICS" : "ALL");
const emptyForm = (role: Role = "STAFF"): FormState => ({
  email: "",
  name: "",
  role,
  scopeType: defaultScopeFor(role),
  scopeCompanyId: "",
  clinicIds: [],
  password: "",
  active: true,
});

/** 列表「診所」欄顯示（MD A.3 格式） */
function scopeLabel(u: Staff): string {
  if (u.scopeType === "ALL") return "全集團";
  if (u.scopeType === "COMPANY") {
    const label = u.companyCode ? `${u.companyCode} ${u.companyName ?? ""}`.trim() : "（公司）";
    return `${label}（${u.companyClinicCount ?? u.clinicCodes.length}）`;
  }
  return u.clinicCodes.length > 0 ? u.clinicCodes.join(", ") : "—";
}

export default function StaffAdmin() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [clinics, setClinics] = useState<ClinicOpt[]>([]);
  const [companies, setCompanies] = useState<CompanyOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, c, co] = await Promise.all([
      fetch("/api/admin/staff", { cache: "no-store" }),
      fetch("/api/admin/clinics", { cache: "no-store" }),
      fetch("/api/admin/companies", { cache: "no-store" }),
    ]);
    if (s.ok) setStaff((await s.json()) as Staff[]);
    if (c.ok) setClinics((await c.json()) as ClinicOpt[]);
    if (co.ok) setCompanies((await co.json()) as CompanyOpt[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setForm(emptyForm("STAFF"));
    setError(null);
    setCreating(true);
    setEditing(null);
  }

  function openEdit(u: Staff) {
    setForm({
      email: u.email,
      name: u.name,
      role: u.role,
      scopeType: u.scopeType,
      scopeCompanyId: u.scopeCompanyId ?? "",
      clinicIds: u.clinicIds,
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

  /** 角色改動 → 範圍重置返該角色 default（SUPERVISOR 恆全集團 — 現行無 scope 概念） */
  function onRoleChange(role: Role) {
    setForm((f) => ({ ...f, role, scopeType: defaultScopeFor(role), scopeCompanyId: "", clinicIds: f.clinicIds }));
  }

  function toggleClinic(id: string) {
    setForm((f) => ({
      ...f,
      clinicIds: f.clinicIds.includes(id) ? f.clinicIds.filter((x) => x !== id) : [...f.clinicIds, id],
    }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const isSupervisor = form.role === "SUPERVISOR";
      const scopeType: ScopeType = isSupervisor ? "ALL" : form.scopeType;
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        role: form.role,
        scopeType,
        scopeCompanyId: scopeType === "COMPANY" ? form.scopeCompanyId || null : null,
        active: form.active,
        ...(form.password ? { newPassword: form.password } : {}),
        ...(creating ? { email: form.email.trim(), password: form.password } : {}),
      };
      // CLINICS 模式 → 診所集合全量送（replace 語義）；非 CLINICS 唔送 clinicIds（server 保持/清理）
      if (scopeType === "CLINICS") {
        payload.clinicIds = form.clinicIds;
      }
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
    "mt-1 w-full rounded-full border border-line-strong bg-panel px-4 py-2.5 text-sm";
  const label = "block text-sm text-t2";
  const isSupervisorForm = form.role === "SUPERVISOR";
  const effectiveScope: ScopeType = isSupervisorForm ? "ALL" : form.scopeType;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-t1">員工管理</h1>
        <button
          onClick={openCreate}
          className="rounded-full bg-brand text-panel text-sm font-semibold px-4 py-2 hover:bg-brand-hover"
        >
          + 新增員工
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-t2">載入中…</p>
      ) : (
        <table className="w-full text-sm bg-panel rounded-[22px] border border-line overflow-hidden">
          <thead className="bg-panel-2 text-left text-t2">
            <tr>
              <th className="px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">Email</th>
              <th className="px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">姓名</th>
              <th className="px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">角色</th>
              <th className="px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">診所（範圍）</th>
              <th className="px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">狀態</th>
              <th className="px-4 py-2.5 text-right text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">操作</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((u) => (
              <tr key={u.id} className="border-b border-line last:border-0 hover:bg-black/[.04]">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">{u.name}</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      u.role === "ADMIN"
                        ? "px-2 py-0.5 rounded-full text-xs font-semibold bg-brand-soft text-brand-text"
                        : "px-2 py-0.5 rounded-full text-xs font-semibold bg-panel-2 text-t2"
                    }
                  >
                    {u.role}
                  </span>
                </td>
                {/* ★ cwi-hub-a：範圍顯示 — 全集團 / `A 菁薈（1）` / `TY, TKW` */}
                <td className="px-4 py-2 font-mono text-xs">{scopeLabel(u)}</td>
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
        <div className="bg-panel rounded-[26px] border border-line p-6 space-y-4 max-w-2xl">
          <h2 className="font-medium text-t1">
            {creating ? "新增員工" : `編輯 ${editing?.email}`}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {/* MD A.3 順序：Email → 姓名 → 角色 → 範圍三 chip → 對應選擇器 */}
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
              <select className={input} value={form.role} onChange={(e) => onRoleChange(e.target.value as Role)}>
                <option value="STAFF">STAFF（店層）</option>
                <option value="ADMIN">ADMIN（管理）</option>
                <option value="SUPERVISOR">SUPERVISOR（主管·全店唯讀）</option>
              </select>
            </label>
            {/* 範圍三 chip（SUPERVISOR 鎖定全集團 — 現行無 scope 概念） */}
            <div className="mt-1">
              <span className={label}>範圍{isSupervisorForm ? "（SUPERVISOR 固定全集團）" : ""}</span>
              <div className="flex gap-2">
                {(
                  [
                    ["ALL", "全集團"],
                    ["COMPANY", "某公司"],
                    ["CLINICS", "指定診所"],
                  ] as [ScopeType, string][]
                ).map(([t, tLabel]) => {
                  const disabled = isSupervisorForm && t !== "ALL";
                  const active = effectiveScope === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      disabled={disabled}
                      onClick={() => setForm({ ...form, scopeType: t })}
                      className={
                        "rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors " +
                        (active
                          ? "bg-brand text-panel border-brand"
                          : "bg-panel-2 text-t2 border-line-strong hover:bg-black/[.06]") +
                        (disabled ? " opacity-40 cursor-not-allowed" : "")
                      }
                    >
                      {tLabel}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* 對應選擇器 */}
            {effectiveScope === "ALL" ? (
              <p className="text-xs text-t3 mt-4 col-span-2">全集團：可见所有診所（含未來新增）。</p>
            ) : effectiveScope === "COMPANY" ? (
              <label className={label}>
                公司（公司加新診所會自動包含，唔使改回呢度）
                <select
                  className={input}
                  value={form.scopeCompanyId}
                  onChange={(e) => setForm({ ...form, scopeCompanyId: e.target.value })}
                >
                  <option value="">— 揀公司 —</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} {c.name}（{c.clinics.map((x) => x.code).join("、")}）
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className={label}>
                診所（可跨公司多選；至少一間）
                <div className="mt-1 flex flex-wrap gap-2">
                  {clinics.map((c) => {
                    const checked = form.clinicIds.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleClinic(c.id)}
                        className={
                          "rounded-full px-3 py-1.5 text-xs font-semibold border " +
                          (checked
                            ? "bg-brand text-panel border-brand"
                            : "bg-panel-2 text-t2 border-line-strong hover:bg-black/[.06]")
                        }
                      >
                        {c.code}
                      </button>
                    );
                  })}
                </div>
                {form.clinicIds.length === 0 && (
                  <p className="text-xs text-warn-text mt-1">請至少揀一間診所</p>
                )}
              </div>
            )}
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
              className="rounded-full bg-brand text-panel text-sm font-semibold px-4 py-2 hover:bg-brand-hover disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button onClick={closeForm} className="rounded-full border border-line-strong bg-panel text-t1 text-sm px-4 py-2 hover:bg-panel-2">
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
