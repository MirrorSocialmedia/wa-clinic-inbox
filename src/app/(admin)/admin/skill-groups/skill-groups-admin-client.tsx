"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 技能組管理 client — ★ cwi-routing-20260906（MD §4.1）。
 *
 * 列表：組名 · code · 成員數 · 服務診所 · 開關。
 * 編輯：成員多選（全部 active staff）+ 服務診所多選（R-4）+ 開關。
 * 資料源：GET /api/admin/skill-groups（一次過返 groups + staff + clinics）；
 * mutation：POST 建組 / PATCH 改（memberIds/clinicIds = 全量 replace 語義）/ DELETE 删組。
 */

interface GroupRow {
  id: string;
  name: string;
  code: string;
  description: string | null;
  enabled: boolean;
  memberCount: number;
  members: { id: string; name: string }[];
  memberIds: string[];
  clinicIds: string[];
  clinicCodes: (string | null)[];
}
interface StaffOpt {
  id: string;
  name: string;
}
interface ClinicOpt {
  id: string;
  name: string;
  code: string;
}
interface LoadData {
  groups: GroupRow[];
  staff: StaffOpt[];
  clinics: ClinicOpt[];
}

export default function SkillGroupsAdmin() {
  const [data, setData] = useState<LoadData | null>(null);
  const [editing, setEditing] = useState<GroupRow | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/skill-groups");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as LoadData);
    } catch (e) {
      setError(`載入失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleEnabled(g: GroupRow) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/skill-groups/${g.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !g.enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(`切換失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(g: GroupRow) {
    if (!confirm(`删組「${g.name}（${g.code}）」？被路由規則引用時會拒（409）。`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/skill-groups/${g.id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(`删除失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="rounded-[24px] bg-panel border border-line p-6">
        {error ? <div className="text-sm text-danger-text">{error}</div> : <div className="text-sm text-t3">載入中…</div>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-lg font-semibold text-t1">技能組</h1>
          <p className="text-xs text-t3 mt-0.5">
            路由規則嘅目標 — 組嘅成員 + 服務診所（R-4：只服務嘅店先會收到該店嘅組個案）
          </p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="text-xs px-3.5 py-1.5 rounded-full bg-brand text-panel font-semibold hover:bg-brand-hover"
        >
          + 新建組
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-danger/40 bg-danger-soft px-4 py-2.5 text-xs text-danger-text">{error}</div>
      )}

      <div className="rounded-[24px] bg-panel border border-line divide-y divide-line overflow-hidden">
        {data.groups.length === 0 && <div className="p-6 text-sm text-t3">未建過組 — 撳右上「+ 新建組」</div>}
        {data.groups.map((g) => (
          <div key={g.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-semibold ${g.enabled ? "text-t1" : "text-t3 line-through"}`}>{g.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-panel-2 text-t3 font-mono">{g.code}</span>
                <span className="text-[11px] text-t3">· {g.memberCount} 成員</span>
              </div>
              <div className="text-[11px] text-t3 mt-0.5 truncate">
                服務：{g.clinicCodes.filter(Boolean).length === data.clinics.length ? "全部診所" : g.clinicCodes.filter(Boolean).join("、") || "（未綁店）"}
              </div>
            </div>
            <button
              onClick={() => setEditing(g)}
              disabled={busy}
              className="text-xs px-3 py-1 rounded-full border border-line text-t2 hover:bg-panel-2 disabled:opacity-40"
            >
              編輯
            </button>
            <button
              onClick={() => void deleteGroup(g)}
              disabled={busy}
              className="text-xs px-3 py-1 rounded-full border border-danger/40 text-danger-text hover:bg-danger-soft disabled:opacity-40"
            >
              删
            </button>
            <Toggle checked={g.enabled} onChange={() => void toggleEnabled(g)} disabled={busy} />
          </div>
        ))}
      </div>

      {editing && (
        <GroupEditor
          data={data}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={`relative w-9 h-5 rounded-full transition-colors flex-none disabled:opacity-40 ${checked ? "bg-ok" : "bg-line"}`}
      title={checked ? "啟用 — 撳返停用" : "停用 — 撳返啟用"}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-panel shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
      />
    </button>
  );
}

function GroupEditor({
  data,
  initial,
  onClose,
  onSaved,
  onError,
}: {
  data: LoadData;
  initial: GroupRow | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string | null) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(initial?.memberIds ?? []);
  const [clinicIds, setClinicIds] = useState<string[]>(initial?.clinicIds ?? data.clinics.map((c) => c.id));
  const [allClinics, setAllClinics] = useState(initial === null);
  const [saving, setSaving] = useState(false);

  function toggleSet(list: string[], id: string, set: (v: string[]) => void) {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  async function save() {
    setSaving(true);
    onError(null);
    try {
      const finalClinics = allClinics ? data.clinics.map((c) => c.id) : clinicIds;
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        memberIds,
        clinicIds: finalClinics,
      };
      const r = await fetch(initial ? `/api/admin/skill-groups/${initial.id}` : "/api/admin/skill-groups", {
        method: initial ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-[24px] bg-panel border border-line shadow-xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-base font-semibold text-t1">{initial ? `編輯：${initial.name}` : "新建技能組"}</h2>

        <label className="block">
          <span className="text-xs font-medium text-t2">組名 *</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="例：療程顧問"
            className="mt-1 w-full rounded-full border border-line bg-panel-2 px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-t2">說明（可空）</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            className="mt-1 w-full rounded-full border border-line bg-panel-2 px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
          />
        </label>

        <div>
          <div className="text-xs font-medium text-t2 mb-1.5">成員（{memberIds.length}）</div>
          <div className="max-h-44 overflow-y-auto rounded-2xl border border-line p-2 grid grid-cols-2 gap-1">
            {data.staff.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-xs text-t1 px-2 py-1 rounded-full hover:bg-panel-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={memberIds.includes(s.id)}
                  onChange={() => toggleSet(memberIds, s.id, setMemberIds)}
                  className="accent-[var(--brand)]"
                />
                <span className="truncate">{s.name}</span>
              </label>
            ))}
            {data.staff.length === 0 && <div className="text-xs text-t3 p-2">冇 active staff</div>}
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 text-xs text-t1 mb-1.5">
            <input
              type="checkbox"
              checked={allClinics}
              onChange={(e) => {
                setAllClinics(e.target.checked);
                if (e.target.checked) setClinicIds(data.clinics.map((c) => c.id));
              }}
              className="accent-[var(--brand)]"
            />
            全部診所
          </label>
          {!allClinics && (
            <div className="rounded-2xl border border-line p-2 flex flex-wrap gap-1">
              {data.clinics.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-1.5 text-xs text-t1 px-2.5 py-1 rounded-full border border-line hover:bg-panel-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={clinicIds.includes(c.id)}
                    onChange={() => toggleSet(clinicIds, c.id, setClinicIds)}
                    className="accent-[var(--brand)]"
                  />
                  {c.code}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="text-xs px-3.5 py-1.5 rounded-full border border-line text-t2 hover:bg-panel-2 disabled:opacity-40">
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || name.trim().length === 0}
            className="text-xs px-3.5 py-1.5 rounded-full bg-brand text-panel font-semibold hover:bg-brand-hover disabled:opacity-40"
          >
            {saving ? "儲存中…" : "儲存"}
          </button>
        </div>
      </div>
    </div>
  );
}
