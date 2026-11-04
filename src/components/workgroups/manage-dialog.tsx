"use client";

/**
 * ★ cwi-workgroup-20261104：老闆「管理群組」— 開群、改名、加／刪任何員工、封存／解封。
 * 冇自動加人：成員完全由老闆揀。管理頁唔顯示訊息內容（要睇內容就將自己加入群）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

interface AdminGroup {
  id: string;
  name: string;
  archived: boolean;
  members: { id: string; name: string; active: boolean }[];
}
interface StaffOpt {
  id: string;
  name: string;
  role: string;
}

const ROLE: Record<string, string> = { ADMIN: "管理員", STAFF: "員工", SUPERVISOR: "主管" };

export function WorkgroupManageDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [groups, setGroups] = useState<AdminGroup[] | null>(null);
  const [staff, setStaff] = useState<StaffOpt[]>([]);
  const [editId, setEditId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/workgroups");
    if (!r.ok) {
      setErr("讀唔到群組");
      return;
    }
    const d = (await r.json()) as { groups: AdminGroup[]; staff: StaffOpt[] };
    setGroups(d.groups);
    setStaff(d.staff);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const editing = editId && editId !== "new" ? (groups?.find((g) => g.id === editId) ?? null) : null;

  function startNew() {
    setEditId("new");
    setName("");
    setPicked(new Set());
    setErr(null);
  }
  function startEdit(g: AdminGroup) {
    setEditId(g.id);
    setName(g.name);
    setPicked(new Set(g.members.map((m) => m.id)));
    setErr(null);
  }

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return staff.filter((x) => !s || x.name.toLowerCase().includes(s));
  }, [staff, q]);

  async function save(extra?: { archived?: boolean }) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      let r: Response;
      if (editId === "new") {
        r = await fetch("/api/admin/workgroups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, memberIds: [...picked] }),
        });
      } else if (editing) {
        const before = new Set(editing.members.map((m) => m.id));
        const addIds = [...picked].filter((id) => !before.has(id));
        // 已停用／已刪嘅舊成員都可以刪
        const removeIds = [...before].filter((id) => !picked.has(id));
        r = await fetch(`/api/admin/workgroups/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(name !== editing.name ? { name } : {}), addIds, removeIds, ...extra }),
        });
      } else return;
      const d = (await r.json().catch(() => null)) as { message?: string } | null;
      if (!r.ok) {
        setErr(d?.message ?? "儲存失敗");
        return;
      }
      await load();
      onChanged();
      setEditId(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label="管理工作群">
      <button type="button" className="absolute inset-0 bg-black/30" aria-label="關閉" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-t-3xl bg-panel shadow-xl md:rounded-3xl" data-e2e="wg-manage">
        <div className="flex items-center border-b border-line px-5 py-3">
          <div className="text-[15px] font-semibold text-t1">{editId ? (editId === "new" ? "新群組" : `編輯「${editing?.name ?? ""}」`) : "管理工作群"}</div>
          <button type="button" onClick={editId ? () => setEditId(null) : onClose} className="ml-auto rounded-full p-1 hover:bg-panel-2" aria-label="關閉">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {!editId ? (
          <div className="flex-1 overflow-y-auto px-5 py-3">
            {groups === null ? (
              <div className="py-6 text-center text-sm text-t3">載入中…</div>
            ) : (
              <>
                {groups.length === 0 && <div className="py-4 text-center text-sm text-t3">未有群組</div>}
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => startEdit(g)}
                    className={`mb-1.5 flex w-full items-center gap-2 rounded-2xl border border-line px-3 py-2 text-left hover:bg-panel-2 ${g.archived ? "opacity-60" : ""}`}
                    data-e2e="wg-manage-row"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-t1">
                        {g.name}
                        {g.archived ? "（已封存）" : ""}
                      </span>
                      <span className="block truncate text-[11.5px] text-t2">
                        {g.members.length} 人{g.members.length ? `：${g.members.map((m) => m.name).join("、")}` : ""}
                      </span>
                    </span>
                    <span className="text-xs text-brand-text">編輯</span>
                  </button>
                ))}
                <button type="button" onClick={startNew} className="mt-2 w-full rounded-full bg-brand py-2.5 text-sm font-medium text-panel" data-e2e="wg-manage-new">
                  ＋ 新群組
                </button>
                <p className="mt-3 text-[11.5px] leading-relaxed text-t3">
                  成員由你揀，冇自動加人。醫生要入群：先喺「管理 → 員工」幫佢開帳號，再喺度加。管理頁唔會顯示訊息內容 — 你要睇內容就將自己加入群。
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="space-y-3 px-5 pt-3">
              <label className="block text-[12px] text-t2">
                群組名
                <input
                  value={name}
                  maxLength={40}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：TKW 店、銷售組"
                  className="mt-1 w-full rounded-full border border-line bg-panel-2 px-3.5 py-2 text-sm text-t1"
                  data-e2e="wg-manage-name"
                />
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-t2">成員（{picked.size} 人）</span>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜尋員工"
                  className="ml-auto w-36 rounded-full border border-line bg-panel-2 px-3 py-1 text-xs"
                />
              </div>
            </div>
            <div className="mt-2 flex-1 overflow-y-auto px-5" data-e2e="wg-manage-staff">
              {shown.map((s) => (
                <label key={s.id} className="flex items-center gap-2 border-b border-line py-2 text-sm text-t1">
                  <input
                    type="checkbox"
                    checked={picked.has(s.id)}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const n = new Set(prev);
                        if (e.target.checked) n.add(s.id);
                        else n.delete(s.id);
                        return n;
                      })
                    }
                  />
                  <span className="flex-1">{s.name}</span>
                  <span className="text-[11px] text-t3">{ROLE[s.role] ?? s.role}</span>
                </label>
              ))}
              {editing?.members
                .filter((m) => !m.active && picked.has(m.id))
                .map((m) => (
                  <label key={m.id} className="flex items-center gap-2 border-b border-line py-2 text-sm text-t3">
                    <input type="checkbox" checked onChange={() => setPicked((prev) => new Set([...prev].filter((x) => x !== m.id)))} />
                    <span className="flex-1">{m.name}（已停用）</span>
                  </label>
                ))}
            </div>
            {err && <div className="px-5 pt-2 text-xs text-danger-text">{err}</div>}
            <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              {editing && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save({ archived: !editing.archived })}
                  className="rounded-full border border-line px-3 py-2 text-xs text-t1 hover:bg-panel-2"
                  data-e2e="wg-manage-archive"
                >
                  {editing.archived ? "解除封存" : "封存（變唯讀）"}
                </button>
              )}
              <button
                type="button"
                disabled={busy || !name.trim()}
                onClick={() => void save()}
                className="ml-auto rounded-full bg-brand px-5 py-2 text-sm font-medium text-panel disabled:opacity-50"
                data-e2e="wg-manage-save"
              >
                {editId === "new" ? "開群" : "儲存"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
