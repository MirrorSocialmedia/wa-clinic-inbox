"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 路由規則管理 client — ★ cwi-routing-20260906（MD §4.2）。
 *
 * 列表按 priority 排序、可拖拉改次序（首個命中即停 — 次序好重要）。
 * 每行：規則名 · 條件摘要 · 目標 · 升級設定 · 開關。
 * 編輯面板：intent 多選 / 關鍵詞 chip input（口語表 normalize 提示）/ 病人類型 /
 *   目標（組 or 單人 or 該店公海）/ 首覆文案（可空）/ 升級（N 分鐘 + 第二級組，可空）。
 *
 * 資料源：GET /api/admin/routing-rules（一次過返 rules + groups + staff + clinics）；
 * mutation：POST 建 / PATCH 改 / DELETE 删 / POST reorder（拖拉）。
 * 即時生效：engine 每次匹配都查 DB（無 cache）— 改完即刻行新規則。
 */

interface RuleRow {
  id: string;
  name: string;
  clinicId: string | null;
  clinicName: string | null;
  clinicCode: string | null;
  priority: number;
  enabled: boolean;
  intents: string[];
  keywords: string[];
  patientType: string | null;
  targetType: "GROUP" | "STAFF" | "CLINIC_POOL";
  targetGroupId: string | null;
  targetGroupName: string | null;
  targetGroupCode: string | null;
  targetStaffId: string | null;
  targetStaffName: string | null;
  autoReplyTemplate: string | null;
  escalateAfterMin: number | null;
  escalateToGroupId: string | null;
  escalateToGroupName: string | null;
  updatedAt: string;
}
interface GroupOpt {
  id: string;
  name: string;
  code: string;
  enabled: boolean;
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
  rules: RuleRow[];
  groups: GroupOpt[];
  staff: StaffOpt[];
  clinics: ClinicOpt[];
}

const INTENTS: { value: string; label: string }[] = [
  { value: "BOOKING_REQUEST", label: "預約" },
  { value: "QUESTION", label: "查詢" },
  { value: "URGENT_PAIN", label: "急症" },
  { value: "COMPLAINT", label: "投訴" },
  { value: "OUT_OF_SCOPE", label: "超出範圍" },
  { value: "OTHER", label: "其他" },
];

function conditionSummary(r: RuleRow): string {
  const parts: string[] = [];
  if (r.intents.length > 0) parts.push(r.intents.map((i) => INTENTS.find((x) => x.value === i)?.label ?? i).join("/"));
  if (r.keywords.length > 0) parts.push(`${r.keywords.join("/")}（關鍵詞）`);
  if (r.patientType) parts.push(r.patientType === "NEW" ? "新客" : "舊客");
  return parts.length > 0 ? parts.join(" + ") : "（空條件 — 全收）";
}

function targetSummary(r: RuleRow): string {
  if (r.targetType === "GROUP") return `👥 ${r.targetGroupName ?? "?"} 組`;
  if (r.targetType === "STAFF") return `👤 ${r.targetStaffName ?? "?"}`;
  return "🏪 該店公海";
}

export default function RoutingRulesAdmin() {
  const [data, setData] = useState<LoadData | null>(null);
  const [scope, setScope] = useState<string>("__global"); // "__global" = clinicId null
  const [editing, setEditing] = useState<RuleRow | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/routing-rules");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as LoadData);
    } catch (e) {
      setError(`載入失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scopeRules = useMemo(() => {
    if (!data) return [];
    return data.rules
      .filter((r) => (scope === "__global" ? r.clinicId === null : r.clinicId === scope))
      .slice()
      .sort((a, b) => a.priority - b.priority);
  }, [data, scope]);

  async function reorder(orderedIds: string[]) {
    if (orderedIds.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/routing-rules/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId: scope === "__global" ? null : scope, orderedIds }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(`排序失敗：${e instanceof Error ? e.message : String(e)}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const ids = scopeRules.map((r) => r.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragId(null);
    setOverId(null);
    void reorder(ids);
  }

  async function toggleEnabled(r: RuleRow) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/routing-rules/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(`切換失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(r: RuleRow) {
    if (!confirm(`删規則「${r.name}」？已標記嘅對話行會保留歷史標記，但唔會再命中。`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/routing-rules/${r.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message ?? `HTTP ${res.status}`);
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

  const scopeTabs: { key: string; label: string }[] = [
    { key: "__global", label: "全局" },
    ...data.clinics.map((c) => ({ key: c.id, label: c.code })),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="font-display text-lg font-semibold text-t1">路由規則</h1>
          <p className="text-xs text-t3 mt-0.5">
            ⚠️ <b>首個命中即停</b> — 順序好重要，可以拖拉改次序（改完即時生效）。店規則同全局規則同名／同優先級時，店規則覆蓋全局。
          </p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="text-xs px-3.5 py-1.5 rounded-full bg-brand text-panel font-semibold hover:bg-brand-hover"
        >
          + 新建規則
        </button>
      </div>

      {/* 店域 tab：全局 / 各店 */}
      <div className="flex gap-1.5 flex-wrap">
        {scopeTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setScope(t.key)}
            aria-pressed={scope === t.key}
            className={`px-3 py-1 rounded-full text-xs ${
              scope === t.key ? "bg-t1 text-canvas font-semibold" : "bg-panel border border-line text-t2 hover:bg-panel-2"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="rounded-2xl border border-danger/40 bg-danger-soft px-4 py-2.5 text-xs text-danger-text">{error}</div>}

      <div className="rounded-[24px] bg-panel border border-line divide-y divide-line overflow-hidden">
        {scopeRules.length === 0 && <div className="p-6 text-sm text-t3">呢個域未有規則</div>}
        {scopeRules.map((r, i) => (
          <div
            key={r.id}
            draggable
            onDragStart={(e) => {
              setDragId(r.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverId(r.id);
            }}
            onDragLeave={() => setOverId((v) => (v === r.id ? null : v))}
            onDrop={() => onDrop(r.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            className={`flex items-center gap-3 px-4 py-3 ${dragId === r.id ? "opacity-40" : ""} ${
              overId === r.id && dragId !== r.id ? "border-t-2 border-t-brand" : ""
            }`}
          >
            <span className="cursor-grab text-t3 select-none text-sm" title="拖拉改次序">
              ⠿
            </span>
            <span className="text-[11px] font-mono text-t3 w-8 flex-none">{i + 1}.</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-sm font-semibold ${r.enabled ? "text-t1" : "text-t3 line-through"}`}>{r.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-panel-2 text-t3">P{r.priority}</span>
              </div>
              <div className="text-[11px] text-t3 mt-0.5 flex flex-wrap gap-x-3">
                <span>條件：{conditionSummary(r)}</span>
                <span>→ {targetSummary(r)}</span>
                {r.escalateAfterMin !== null && (
                  <span className="text-danger-text">
                    ⏱ {r.escalateAfterMin} 分鐘無接手 → 升級 {r.escalateToGroupName ?? "?"}
                  </span>
                )}
                {r.autoReplyTemplate && <span title={r.autoReplyTemplate}>✉️ 有首覆文案</span>}
              </div>
            </div>
            <button
              onClick={() => setEditing(r)}
              disabled={busy}
              className="text-xs px-3 py-1 rounded-full border border-line text-t2 hover:bg-panel-2 disabled:opacity-40"
            >
              編輯
            </button>
            <button
              onClick={() => void deleteRule(r)}
              disabled={busy}
              className="text-xs px-3 py-1 rounded-full border border-danger/40 text-danger-text hover:bg-danger-soft disabled:opacity-40"
            >
              删
            </button>
            <Toggle checked={r.enabled} onChange={() => void toggleEnabled(r)} disabled={busy} />
          </div>
        ))}
      </div>

      {editing && (
        <RuleEditor
          data={data}
          scope={scope}
          initial={editing === "new" ? null : editing}
          nextPriority={(scopeRules.length + 1) * 10}
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
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-panel shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

function RuleEditor({
  data,
  scope,
  initial,
  nextPriority,
  onClose,
  onSaved,
  onError,
}: {
  data: LoadData;
  scope: string;
  initial: RuleRow | null;
  nextPriority: number;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string | null) => void;
}) {
  const clinicId = scope === "__global" ? null : scope;
  const [name, setName] = useState(initial?.name ?? "");
  const [priority, setPriority] = useState(initial?.priority ?? nextPriority);
  const [intents, setIntents] = useState<string[]>(initial?.intents ?? []);
  const [keywords, setKeywords] = useState<string[]>(initial?.keywords ?? []);
  const [kwInput, setKwInput] = useState("");
  const [patientType, setPatientType] = useState<string>(initial?.patientType ?? "");
  const [targetType, setTargetType] = useState<RuleRow["targetType"]>(initial?.targetType ?? "GROUP");
  const [targetGroupId, setTargetGroupId] = useState(initial?.targetGroupId ?? data.groups[0]?.id ?? "");
  const [targetStaffId, setTargetStaffId] = useState(initial?.targetStaffId ?? data.staff[0]?.id ?? "");
  const [template, setTemplate] = useState(initial?.autoReplyTemplate ?? "");
  const [escalateOn, setEscalateOn] = useState(initial?.escalateAfterMin != null);
  const [escalateMin, setEscalateMin] = useState(initial?.escalateAfterMin ?? 15);
  const [escalateGroup, setEscalateGroup] = useState(initial?.escalateToGroupId ?? "");
  const [saving, setSaving] = useState(false);

  function addKeyword() {
    const parts = kwInput
      .split(/[,，、\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    setKeywords((prev) => [...new Set([...prev, ...parts])].slice(0, 30));
    setKwInput("");
  }

  async function save() {
    setSaving(true);
    onError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        priority,
        intents,
        keywords,
        patientType: patientType || null,
        targetType,
        targetGroupId: targetType === "GROUP" ? targetGroupId || null : null,
        targetStaffId: targetType === "STAFF" ? targetStaffId || null : null,
        autoReplyTemplate: template.trim() || null,
        escalateAfterMin: escalateOn ? escalateMin : null,
        escalateToGroupId: escalateOn ? escalateGroup || null : null,
      };
      if (initial) {
        const r = await fetch(`/api/admin/routing-rules/${initial.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      } else {
        const r = await fetch("/api/admin/routing-rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, clinicId }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      }
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
        className="w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-[24px] bg-panel border border-line shadow-xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-base font-semibold text-t1">
          {initial ? `編輯規則：${initial.name}` : "新建路由規則"}
          <span className="ml-2 text-xs font-normal text-t3">（{clinicId ? data.clinics.find((c) => c.id === clinicId)?.code : "全局"}）</span>
        </h2>

        <div className="grid grid-cols-2 gap-3">
          <label className="block col-span-2">
            <span className="text-xs font-medium text-t2">規則名 *</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder="例：高價值療程"
              className="mt-1 w-full rounded-full border border-line bg-panel-2 px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-t2">優先級（細數行先）</span>
            <input
              type="number"
              min={1}
              max={10000}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value) || 0)}
              className="mt-1 w-full rounded-full border border-line bg-panel-2 px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-t2">病人類型</span>
            <select
              value={patientType}
              onChange={(e) => setPatientType(e.target.value)}
              className="mt-1 w-full rounded-full border border-line bg-panel-2 px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
            >
              <option value="">唔限</option>
              <option value="NEW">新客</option>
              <option value="RETURNING">舊客</option>
            </select>
          </label>
        </div>

        <div>
          <div className="text-xs font-medium text-t2 mb-1.5">Intent（可多選；留空 = 唔限）</div>
          <div className="flex flex-wrap gap-1.5">
            {INTENTS.map((it) => (
              <button
                key={it.value}
                onClick={() => setIntents((prev) => (prev.includes(it.value) ? prev.filter((x) => x !== it.value) : [...prev, it.value]))}
                className={`px-3 py-1 rounded-full text-xs border ${
                  intents.includes(it.value) ? "bg-brand-soft border-brand text-brand-text font-semibold" : "border-line text-t2 hover:bg-panel-2"
                }`}
              >
                {it.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs font-medium text-t2 mb-1.5">關鍵詞（chip；會經口語表 normalize 先比對）</div>
          <div className="flex flex-wrap items-center gap-1.5 rounded-full border border-line bg-panel-2 px-3 py-1.5">
            {keywords.map((k) => (
              <span key={k} className="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full bg-brand-soft text-brand-text">
                {k}
                <button onClick={() => setKeywords((prev) => prev.filter((x) => x !== k))} aria-label={`移除 ${k}`}>
                  ×
                </button>
              </span>
            ))}
            <input
              value={kwInput}
              onChange={(e) => setKwInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addKeyword();
                }
              }}
              onBlur={addKeyword}
              placeholder={keywords.length === 0 ? "例：矯齒、植牙（Enter 添加）" : "繼續添加…"}
              className="flex-1 min-w-[120px] bg-transparent text-sm text-t1 placeholder:text-t3 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <div className="text-xs font-medium text-t2 mb-1.5">目標</div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {(
              [
                ["GROUP", "技能組"],
                ["STAFF", "單人"],
                ["CLINIC_POOL", "該店公海"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setTargetType(v)}
                className={`px-3 py-1 rounded-full text-xs border ${
                  targetType === v ? "bg-brand-soft border-brand text-brand-text font-semibold" : "border-line text-t2 hover:bg-panel-2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {targetType === "GROUP" && (
            <select
              value={targetGroupId}
              onChange={(e) => setTargetGroupId(e.target.value)}
              className="w-full rounded-full border border-line bg-panel-2 px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
            >
              {data.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}（{g.code}）{g.enabled ? "" : " — 已停用"}
                </option>
              ))}
            </select>
          )}
          {targetType === "STAFF" && (
            <select
              value={targetStaffId}
              onChange={(e) => setTargetStaffId(e.target.value)}
              className="w-full rounded-full border border-line bg-panel-2 px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
            >
              {data.staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <label className="block">
          <span className="text-xs font-medium text-t2">首覆文案（可空 — R-7：命中後 L2 自動首覆；L1 出草稿）</span>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="例：多謝你嘅查詢！我哋會安排療程顧問跟進…"
            className="mt-1 w-full rounded-2xl border border-line bg-panel-2 px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
          />
        </label>

        <div className="rounded-2xl border border-line bg-panel-2 p-3 space-y-2">
          <label className="flex items-center gap-2 text-xs text-t1">
            <input
              type="checkbox"
              checked={escalateOn}
              onChange={(e) => setEscalateOn(e.target.checked)}
              className="accent-[var(--brand)]"
            />
            升級（N 分鐘冇人接手 → 第二級組；只升一次）
          </label>
          {escalateOn && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-t3">分鐘</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={escalateMin}
                  onChange={(e) => setEscalateMin(Number(e.target.value) || 0)}
                  className="mt-1 w-full rounded-full border border-line bg-panel px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
                />
              </label>
              <label className="block">
                <span className="text-xs text-t3">第二級組</span>
                <select
                  value={escalateGroup}
                  onChange={(e) => setEscalateGroup(e.target.value)}
                  className="mt-1 w-full rounded-full border border-line bg-panel px-4 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
                >
                  <option value="">— 揀組 —</option>
                  {data.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}（{g.code}）
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="text-xs px-3.5 py-1.5 rounded-full border border-line text-t2 hover:bg-panel-2 disabled:opacity-40">
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || name.trim().length === 0 || (targetType === "GROUP" && !targetGroupId) || (targetType === "STAFF" && !targetStaffId) || (escalateOn && !escalateGroup)}
            className="text-xs px-3.5 py-1.5 rounded-full bg-brand text-panel font-semibold hover:bg-brand-hover disabled:opacity-40"
          >
            {saving ? "儲存中…" : "儲存"}
          </button>
        </div>
      </div>
    </div>
  );
}
