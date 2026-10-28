"use client";

/**
 * ★ cwi-sales-20261028：/admin/sales client — 規則設定｜傭金項目｜病人歸屬。
 * 數據：/api/admin/sales/settings、/catalog、/catalog/refresh、/commission-items、/owners。
 * 寫入只限集團管理員（server 403 會顯示原因）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { WLoading } from "@/components/ui/w-loader";

type Tab = "settings" | "items" | "owners";

interface Settings {
  protectionDays: number;
  highValueProtectionDays: number;
  maxDaysAhead: number;
  cycleCap: number;
  noShowCap: number;
  concurrentCap: number;
  boundAutoReleaseMonths: number;
  unansweredNotifyMinutes: number;
  notifyWindowStart: string;
  notifyWindowEnd: string;
  intentLabels: string[];
}

interface ClinicOpt {
  id: string;
  code: string;
}

interface Catalog {
  feeItems: { extId: string; code: string; des: string; fee: number }[];
  practitioners: { extId: string; code: string; name: string; nameChi: string | null }[];
  lastRun: { status: string; finishedAt: string | null; error: string | null } | null;
}

interface ItemRow {
  feeItemExtId: string;
  ratePct: number;
  category: string | null;
  highValue: boolean;
  active: boolean;
}

interface Owner {
  patientApricotId: string;
  patientCode: string | null;
  patientName: string | null;
  state: "PROTECTED" | "BOUND" | "POOL";
  salesStaffId: string | null;
  salesName: string | null;
  lastSalesName: string | null;
  protectedUntil: string | null;
  rounds: number;
  lastApptDate: string | null;
  conversationId: string | null;
}

const NUM_FIELDS: { key: keyof Settings; label: string; unit: string }[] = [
  { key: "protectionDays", label: "保護期（預約日後）", unit: "日" },
  { key: "highValueProtectionDays", label: "高價項目保護期", unit: "日" },
  { key: "maxDaysAhead", label: "預約日最遠幾耐先有保護", unit: "日內" },
  { key: "cycleCap", label: "循環邀約上限", unit: "輪" },
  { key: "noShowCap", label: "連續 no-show 出公海", unit: "次" },
  { key: "concurrentCap", label: "每人同時保護中病人上限", unit: "個" },
  { key: "boundAutoReleaseMonths", label: "綁定病人冇付款自動解除", unit: "個月" },
  { key: "unansweredNotifyMinutes", label: "綁定對話冇人覆通知主管", unit: "分鐘" },
];

const STATE_LABEL: Record<Owner["state"], string> = { PROTECTED: "保護中", BOUND: "綁定", POOL: "銷售公海" };

const md = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const mdhm = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    const data = (await res.json().catch(() => null)) as (T & { message?: string; error?: string }) | null;
    if (!res.ok) return { ok: false, error: data?.message ?? data?.error ?? `HTTP ${res.status}` };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "網絡錯誤" };
  }
}

const card = "bg-panel rounded-[22px] border border-line p-5";
const inputCls = "rounded-full border border-line-strong bg-panel px-3 py-1.5 text-sm text-t1";

export default function SalesAdminClient() {
  const [tab, setTab] = useState<Tab>("settings");
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-semibold text-t1">銷售</h1>
        <div className="flex gap-1.5" role="tablist">
          {(
            [
              ["settings", "規則設定"],
              ["items", "傭金項目"],
              ["owners", "病人歸屬"],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold border ${tab === k ? "bg-brand text-panel border-brand" : "bg-panel-2 text-t2 border-line-strong hover:bg-black/[.06]"}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      {tab === "settings" && <SettingsTab />}
      {tab === "items" && <ItemsTab />}
      {tab === "owners" && <OwnersTab />}
    </div>
  );
}

function SettingsTab() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ settings: Settings }>("/api/admin/sales/settings").then((r) => (r.ok ? setS(r.data.settings) : setMsg(r.error)));
  }, []);
  if (!s) return msg ? <p className="text-sm text-danger-text">{msg}</p> : <WLoading />;

  async function save() {
    if (!s) return;
    setBusy(true);
    setMsg(null);
    const r = await api<{ settings: Settings }>("/api/admin/sales/settings", { method: "PUT", body: JSON.stringify(s) });
    setBusy(false);
    if (r.ok) {
      setS(r.data.settings);
      setMsg("已保存");
    } else setMsg(r.error);
  }

  return (
    <div className={`${card} space-y-4 max-w-3xl`}>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
        {NUM_FIELDS.map((f) => (
          <label key={f.key} className="flex items-center justify-between gap-3 text-sm text-t2">
            <span>{f.label}</span>
            <span className="flex items-center gap-1.5 shrink-0">
              <input
                id={`sales-setting-${f.key}`}
                type="number"
                min={1}
                className={`${inputCls} w-20 text-right tabular-nums`}
                value={s[f.key] as number}
                onChange={(e) => setS({ ...s, [f.key]: Number(e.target.value) })}
              />
              <span className="text-xs text-t3 w-10">{f.unit}</span>
            </span>
          </label>
        ))}
        <label className="flex items-center justify-between gap-3 text-sm text-t2">
          <span>冇人覆通知時段（香港時間）</span>
          <span className="flex items-center gap-1.5 shrink-0">
            <input id="sales-setting-window-start" type="time" className={inputCls} value={s.notifyWindowStart} onChange={(e) => setS({ ...s, notifyWindowStart: e.target.value })} />
            <span className="text-t3">–</span>
            <input id="sales-setting-window-end" type="time" className={inputCls} value={s.notifyWindowEnd} onChange={(e) => setS({ ...s, notifyWindowEnd: e.target.value })} />
          </span>
        </label>
        <label className="flex items-center justify-between gap-3 text-sm text-t2">
          <span>意向分級名稱</span>
          <span className="flex items-center gap-1.5 shrink-0">
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                id={`sales-setting-intent-${i}`}
                className={`${inputCls} w-14 text-center`}
                maxLength={6}
                value={s.intentLabels[i] ?? ""}
                onChange={(e) => {
                  const next = [...s.intentLabels];
                  next[i] = e.target.value;
                  setS({ ...s, intentLabels: next });
                }}
              />
            ))}
          </span>
        </label>
      </div>
      <p className="text-xs text-t3">保護期由銷售經 inbox 落預約或者發 Flow 開始，到預約日後指定日數完。改動即時套用落新嘅預約；已經保護中嘅病人到期日唔變。</p>
      <div className="flex items-center gap-3">
        <button onClick={() => void save()} disabled={busy} className="rounded-full bg-brand text-panel text-sm font-semibold px-4 py-2 hover:bg-brand-hover disabled:opacity-50">
          {busy ? "保存中…" : "保存"}
        </button>
        {msg && <span className="text-sm text-t2">{msg}</span>}
      </div>
    </div>
  );
}

function ItemsTab() {
  const [clinics, setClinics] = useState<ClinicOpt[]>([]);
  const [clinicId, setClinicId] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [rows, setRows] = useState<Map<string, ItemRow>>(new Map());
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "refresh" | null>(null);

  useEffect(() => {
    void api<ClinicOpt[]>("/api/admin/clinics").then((r) => {
      if (r.ok) {
        setClinics(r.data);
        if (r.data[0]) setClinicId(r.data[0].id);
      }
    });
  }, []);

  const load = useCallback(async (cid: string) => {
    if (!cid) return;
    setBusy("load");
    setMsg(null);
    const [c, i] = await Promise.all([
      api<{ catalog: Catalog }>(`/api/admin/sales/catalog?clinicId=${encodeURIComponent(cid)}`),
      api<{ items: ItemRow[] }>(`/api/admin/sales/commission-items?clinicId=${encodeURIComponent(cid)}`),
    ]);
    setBusy(null);
    if (!c.ok) {
      setCatalog(null);
      setMsg(c.error);
      return;
    }
    setCatalog(c.data.catalog);
    setRows(new Map((i.ok ? i.data.items : []).map((x) => [x.feeItemExtId, x])));
  }, []);

  useEffect(() => {
    void load(clinicId);
  }, [clinicId, load]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (catalog?.feeItems ?? []).filter((f) => !term || f.code.toLowerCase().includes(term) || f.des.toLowerCase().includes(term));
  }, [catalog, q]);

  function update(extId: string, patch: Partial<ItemRow>) {
    setRows((prev) => {
      const next = new Map(prev);
      const cur = next.get(extId) ?? { feeItemExtId: extId, ratePct: 0, category: null, highValue: false, active: false };
      next.set(extId, { ...cur, ...patch });
      return next;
    });
  }

  async function save() {
    setBusy("save");
    setMsg(null);
    const items = [...rows.values()].map((r) => ({ feeItemExtId: r.feeItemExtId, ratePct: r.ratePct, category: r.category, highValue: r.highValue, active: r.active }));
    const r = await api<{ items: ItemRow[] }>("/api/admin/sales/commission-items", { method: "PUT", body: JSON.stringify({ clinicId, items }) });
    setBusy(null);
    if (r.ok) {
      setRows(new Map(r.data.items.map((x) => [x.feeItemExtId, x])));
      setMsg("已保存（之後開嘅單用新 %，舊單唔變）");
    } else setMsg(r.error);
  }

  async function refresh() {
    setBusy("refresh");
    setMsg(null);
    const r = await api<{ result: { status: string; counts: Record<string, number> } }>("/api/admin/sales/catalog/refresh", { method: "POST" });
    setBusy(null);
    if (!r.ok) {
      setMsg(r.error);
      return;
    }
    setMsg(`名單已更新（${r.data.result.status}）`);
    await load(clinicId);
  }

  return (
    <div className="space-y-4">
      <div className={`${card} flex flex-wrap items-center gap-3`}>
        <select id="sales-items-clinic" className={inputCls} value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code}
            </option>
          ))}
        </select>
        <input id="sales-items-search" className={`${inputCls} flex-1 min-w-[10rem]`} placeholder="搜項目代碼／名稱" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-xs text-t3">
          名單上次更新：{catalog?.lastRun ? `${mdhm(catalog.lastRun.finishedAt)}（${catalog.lastRun.status}）` : "—"} · 醫生 {catalog?.practitioners.length ?? 0} 位
        </span>
        <button
          onClick={() => void refresh()}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-panel text-t1 text-xs px-3 py-1.5 hover:bg-panel-2 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy === "refresh" ? "animate-spin" : ""}`} aria-hidden />
          立即更新名單
        </button>
      </div>
      {msg && <p className="text-sm text-t2">{msg}</p>}
      {busy === "load" ? (
        <WLoading />
      ) : catalog ? (
        <div className="overflow-x-auto bg-panel rounded-[22px] border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-t2">
              <tr>
                <th className="px-4 py-2.5 text-[11px] font-semibold">計傭金</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">代碼</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">項目</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">標價</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">%</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">類別</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">高價（長保護期）</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((f) => {
                const r = rows.get(f.extId);
                const on = !!r?.active;
                return (
                  <tr key={f.extId} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        aria-label={`${f.des} 計傭金`}
                        checked={on}
                        onChange={(e) => update(f.extId, { active: e.target.checked })}
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{f.code}</td>
                    <td className="px-4 py-2">{f.des}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{f.fee.toLocaleString("en-HK")}</td>
                    <td className="px-4 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.5}
                        aria-label={`${f.des} 傭金 %`}
                        disabled={!on}
                        className={`${inputCls} w-20 text-right tabular-nums disabled:opacity-40`}
                        value={r?.ratePct ?? 0}
                        onChange={(e) => update(f.extId, { ratePct: Number(e.target.value) })}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        aria-label={`${f.des} 類別`}
                        disabled={!on}
                        className={`${inputCls} w-28 disabled:opacity-40`}
                        placeholder="例如 植牙"
                        value={r?.category ?? ""}
                        onChange={(e) => update(f.extId, { category: e.target.value || null })}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        aria-label={`${f.des} 高價項目`}
                        disabled={!on}
                        checked={!!r?.highValue}
                        onChange={(e) => update(f.extId, { highValue: e.target.checked })}
                      />
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-t3 text-sm">
                    冇收費項目 — 撳「立即更新名單」由 Apricot 拎
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      <button onClick={() => void save()} disabled={busy !== null || !catalog} className="rounded-full bg-brand text-panel text-sm font-semibold px-4 py-2 hover:bg-brand-hover disabled:opacity-50">
        {busy === "save" ? "保存中…" : "保存傭金項目"}
      </button>
    </div>
  );
}

function OwnersTab() {
  const [state, setState] = useState<"" | Owner["state"]>("");
  const [owners, setOwners] = useState<Owner[] | null>(null);
  const [sales, setSales] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ owners: Owner[]; sales: { id: string; name: string }[] }>(`/api/admin/sales/owners${state ? `?state=${state}` : ""}`);
    if (r.ok) {
      setOwners(r.data.owners);
      setSales(r.data.sales);
    } else setMsg(r.error);
  }, [state]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setMsg(null);
    const r = await api<{ ok: true }>("/api/admin/sales/owners", { method: "POST", body: JSON.stringify(body) });
    setBusy(null);
    if (!r.ok) setMsg(r.error);
    await load();
  }

  return (
    <div className="space-y-4">
      <div className={`${card} flex flex-wrap items-center gap-3`}>
        <select id="sales-owners-state" className={inputCls} value={state} onChange={(e) => setState(e.target.value as "" | Owner["state"])}>
          <option value="">全部狀態</option>
          <option value="PROTECTED">保護中</option>
          <option value="BOUND">綁定</option>
          <option value="POOL">銷售公海</option>
        </select>
        <span className="text-xs text-t3">上線前已有嘅病人：喺病人對話右欄「銷售」由老闆指派。轉移後嘅付款歸新銷售。</span>
      </div>
      {msg && <p className="text-sm text-danger-text">{msg}</p>}
      {!owners ? (
        <WLoading />
      ) : (
        <div className="overflow-x-auto bg-panel rounded-[22px] border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-t2">
              <tr>
                <th className="px-4 py-2.5 text-[11px] font-semibold">病人</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">狀態</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">負責銷售</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">保護到</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">最近預約</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {owners.map((o) => {
                const key = o.patientApricotId;
                const to = pick[key] ?? "";
                return (
                  <tr key={key} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      {o.conversationId ? (
                        <a className="text-brand-text hover:underline" href={`/inbox?conv=${encodeURIComponent(o.conversationId)}`}>
                          {o.patientCode ?? o.patientApricotId.slice(-8)}
                        </a>
                      ) : (
                        <span className="font-mono text-xs">{o.patientCode ?? o.patientApricotId.slice(-8)}</span>
                      )}
                      {o.patientName && <span className="ml-1.5 text-t3 text-xs">{o.patientName}</span>}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${o.state === "POOL" ? "bg-panel-2 text-t2" : "bg-brand-soft text-brand-text"}`}>{STATE_LABEL[o.state]}</span>
                      {o.state === "PROTECTED" && <span className="ml-1 text-[11px] text-t3">第 {o.rounds} 輪</span>}
                    </td>
                    <td className="px-4 py-2">{o.salesName ?? (o.lastSalesName ? <span className="text-t3">（上次：{o.lastSalesName}）</span> : "—")}</td>
                    <td className="px-4 py-2 tabular-nums">{o.state === "PROTECTED" ? md(o.protectedUntil) : "—"}</td>
                    <td className="px-4 py-2 tabular-nums">{o.lastApptDate ? o.lastApptDate.slice(5).replace("-", "/") : "—"}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <select aria-label="轉畀邊個銷售" className={`${inputCls} text-xs`} value={to} onChange={(e) => setPick({ ...pick, [key]: e.target.value })}>
                          <option value="">揀銷售…</option>
                          {sales
                            .filter((s) => s.id !== o.salesStaffId)
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                        </select>
                        <button
                          disabled={!to || busy === key}
                          onClick={() =>
                            void act(o.state === "POOL" ? { action: "assign", patientApricotId: key, toStaffId: to, state: "BOUND" } : { action: "transfer", patientApricotId: key, toStaffId: to }, key)
                          }
                          className="rounded-full bg-brand text-panel text-xs font-semibold px-3 py-1.5 disabled:opacity-40"
                        >
                          {o.state === "POOL" ? "指派" : "轉移"}
                        </button>
                        {o.state !== "POOL" && (
                          <button
                            disabled={busy === key}
                            onClick={() => void act({ action: "release", patientApricotId: key }, key)}
                            className="rounded-full border border-line-strong bg-panel text-t1 text-xs px-3 py-1.5 hover:bg-panel-2 disabled:opacity-40"
                          >
                            放返公海
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {owners.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-t3 text-sm">
                    未有病人歸屬 — 銷售經 inbox 落預約之後就會出現
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
