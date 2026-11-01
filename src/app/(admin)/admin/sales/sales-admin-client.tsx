"use client";

/**
 * ★ cwi-sales-20261028：/admin/sales client — 規則設定｜傭金項目｜病人歸屬｜對單（第 2 期）｜傭金（第 3 期）｜月結（第 4 期）。
 * 數據：/api/admin/sales/settings、/catalog、/catalog/refresh、/commission-items、/owners、/reviews。
 * 寫入只限集團管理員（server 403 會顯示原因）。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { WLoading } from "@/components/ui/w-loader";

type Tab = "settings" | "items" | "owners" | "reviews" | "commission" | "close";

interface Settings {
  protectionDays: number;
  highValueProtectionDays: number;
  maxDaysAhead: number;
  cycleCap: number;
  noShowCap: number;
  expiryRemindDays: number;
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

const NUM_FIELDS: { key: keyof Settings; label: string; unit: string; min?: number }[] = [
  { key: "protectionDays", label: "保護期（預約日後）", unit: "日" },
  { key: "highValueProtectionDays", label: "高價項目保護期", unit: "日" },
  { key: "maxDaysAhead", label: "預約日最遠幾耐先有保護", unit: "日內" },
  { key: "cycleCap", label: "循環邀約上限", unit: "輪" },
  { key: "noShowCap", label: "連續 no-show 出公海（0 = 唔放）", unit: "次", min: 0 },
  { key: "expiryRemindDays", label: "保護期到期前提醒銷售（0 = 唔提）", unit: "日前", min: 0 },
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
  // ★ 第 5 期（U7）：對單待批數 badge（老闆一入嚟就見到有幾多要批；workforce 連唔到 = 唔顯示）
  const [openReviews, setOpenReviews] = useState<number | null>(null);
  const refreshOpen = useCallback(async () => {
    const r = await api<{ reviews: { status: string }[] }>("/api/admin/sales/reviews?status=OPEN");
    setOpenReviews(r.ok ? r.data.reviews.length : null);
  }, []);
  useEffect(() => {
    void refreshOpen();
  }, [refreshOpen, tab]);
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
              ["reviews", "對單"],
              ["commission", "傭金"],
              ["close", "月結"],
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
              {k === "reviews" && (openReviews ?? 0) > 0 && (
                <span className={`ml-1.5 inline-flex min-w-[18px] justify-center rounded-full px-1 text-[10px] ${tab === k ? "bg-panel text-brand-text" : "bg-brand text-panel"}`} data-e2e="sales-reviews-badge">
                  {openReviews}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      {tab === "settings" && <SettingsTab />}
      {tab === "items" && <ItemsTab />}
      {tab === "owners" && <OwnersTab />}
      {tab === "reviews" && <ReviewsTab />}
      {tab === "commission" && <CommissionTab />}
      {tab === "close" && <CloseTab />}
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
                min={f.min ?? 1}
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
  const [onlyUnset, setOnlyUnset] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "refresh" | "copy" | null>(null);

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

  // ★ 第 5 期（U6）：未設定 = 從來冇揀過計唔計（新項目由 Apricot 加入）— 提老闆睇吓要唔要計傭金
  const unsetCount = useMemo(() => (catalog?.feeItems ?? []).filter((f) => !rows.has(f.extId)).length, [catalog, rows]);
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (catalog?.feeItems ?? [])
      .filter((f) => !onlyUnset || !rows.has(f.extId))
      .filter((f) => !term || f.code.toLowerCase().includes(term) || f.des.toLowerCase().includes(term));
  }, [catalog, q, onlyUnset, rows]);

  async function copyToAll() {
    const from = clinics.find((c) => c.id === clinicId)?.code ?? "";
    if (!window.confirm(`將 ${from} 嘅傭金項目設定（%、類別、高價、計唔計）套用到所有分店？\n用項目代碼對返；其他分店冇呢個代碼就跳過。舊單唔變。`)) return;
    setBusy("copy");
    setMsg(null);
    const r = await api<{ items: number; results: { clinicCode: string; applied: number; missing: number; error: string | null }[] }>("/api/admin/sales/commission-items/copy", {
      method: "POST",
      body: JSON.stringify({ fromClinicId: clinicId }),
    });
    setBusy(null);
    if (!r.ok) return setMsg(r.error);
    setMsg(
      `已套用：${r.data.results.map((x) => (x.error ? `${x.clinicCode} 失敗（${x.error}）` : `${x.clinicCode} ${x.applied} 項${x.missing ? `（${x.missing} 項冇呢個代碼）` : ""}`)).join("；") || "冇其他分店"}`
    );
  }

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
        <label className="inline-flex items-center gap-1.5 text-xs text-t2">
          <input type="checkbox" checked={onlyUnset} onChange={(e) => setOnlyUnset(e.target.checked)} data-e2e="sales-items-only-unset" />
          只睇未設定
        </label>
        <button
          onClick={() => void copyToAll()}
          disabled={busy !== null || rows.size === 0}
          className="rounded-full border border-line-strong bg-panel text-t1 text-xs px-3 py-1.5 hover:bg-panel-2 disabled:opacity-50"
          data-e2e="sales-items-copy-all"
        >
          {busy === "copy" ? "套用緊…" : "套用到所有分店"}
        </button>
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
      {catalog && unsetCount > 0 && !onlyUnset && (
        <p className="text-xs text-t1 rounded-2xl bg-panel-2 border border-line px-3 py-2" data-e2e="sales-items-unset-hint">
          有 {unsetCount} 個收費項目未設定計唔計傭金（例如 Apricot 新加嘅項目）— 剔「只睇未設定」逐個睇。
          <button
            type="button"
            className="ml-2 text-brand-text hover:underline"
            onClick={() => {
              for (const f of catalog.feeItems) if (!rows.has(f.extId)) update(f.extId, { active: false });
              setMsg("未設定嘅項目已標做「唔計」— 記得撳保存");
            }}
            data-e2e="sales-items-mark-unset"
          >
            其餘全部標做唔計
          </button>
        </p>
      )}
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

interface Review {
  id: string;
  kind: string;
  kindLabel?: string;
  status: "OPEN" | "APPROVED" | "REJECTED" | "ACKNOWLEDGED";
  salesNote?: string | null;
  evidence?: { staffMessages: number; patientMessages: number; lastStaffMessageAt: string | null } | null;
  apricotBillCode: string | null;
  salesStaffName: string | null;
  salesApricotUserId: string | null;
  patientApricotId: string | null;
  patientCode: string | null;
  patientName: string | null;
  conversationId: string | null;
  amount: number | null;
  approvedPct: number | null;
  note: string | null;
  decidedAt: string | null;
  createdAt: string;
}

const REVIEW_STATUS: Record<Review["status"], string> = { OPEN: "待批", APPROVED: "已批", REJECTED: "已拒", ACKNOWLEDGED: "已知悉" };

/** 老闆對單：批（可部分 %）／拒（要原因）— 只限集團管理員（server 403 會顯示） */
function ReviewsTab() {
  const [status, setStatus] = useState<"" | Review["status"]>("OPEN");
  const [rows, setRows] = useState<Review[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pct, setPct] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ reviews: Review[]; error?: string }>(`/api/admin/sales/reviews${status ? `?status=${status}` : ""}`);
    if (r.ok) {
      setRows(r.data.reviews);
      if (r.data.error) setMsg(r.data.error);
    } else setMsg(r.error);
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, decision: "APPROVED" | "REJECTED" | "ACKNOWLEDGED") {
    const p = pct[id]?.trim();
    const approvedPct = decision === "APPROVED" && p ? Number(p) : null;
    if (approvedPct != null && !(approvedPct >= 0 && approvedPct <= 100)) return setMsg("批核 % 要喺 0–100");
    if (decision === "REJECTED" && !(note[id] ?? "").trim()) return setMsg("拒絕要寫原因");
    setBusy(id);
    setMsg(null);
    const r = await api<{ ok: true }>(`/api/admin/sales/reviews/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision, approvedPct, note: (note[id] ?? "").trim() || null }),
    });
    setBusy(null);
    if (!r.ok) setMsg(r.error);
    await load();
  }

  return (
    <div className="space-y-4">
      <div className={`${card} flex flex-wrap items-center gap-3`}>
        <select id="sales-reviews-status" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as "" | Review["status"])}>
          <option value="OPEN">待批</option>
          <option value="APPROVED">已批</option>
          <option value="REJECTED">已拒</option>
          <option value="ACKNOWLEDGED">已知悉</option>
          <option value="">全部</option>
        </select>
        <span className="text-xs text-t3">
          保護外病人開單、Apricot 直接開／前台幫負責銷售嘅病人開單、銷售員被改、開單日冇打卡申訴 — 批咗先計傭金（可以批部分 %）；批「保護外／直接開／前台幫開」會將冇人負責嘅病人綁定畀嗰個銷售。「單被修改」只係通知，撳已知悉。
        </span>
      </div>
      {msg && <p className="text-sm text-danger-text">{msg}</p>}
      {!rows ? (
        <WLoading />
      ) : (
        <div className="overflow-x-auto bg-panel rounded-[22px] border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-t2">
              <tr>
                <th className="px-4 py-2.5 text-[11px] font-semibold">單號</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">原因</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">銷售</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">病人</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">金額</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">決定</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 align-top" data-e2e="sales-review-row">
                  <td className="px-4 py-2 tabular-nums">
                    {r.apricotBillCode ?? "—"}
                    <div className="text-[11px] text-t3">{mdhm(r.createdAt)}</div>
                  </td>
                  <td className="px-4 py-2">
                    {r.kindLabel ?? r.kind}
                    {r.evidence && (
                      <div className="text-[11px] text-t3 mt-0.5" data-e2e="sales-review-evidence">
                        開單前 30 日：銷售覆咗 {r.evidence.staffMessages} 句、病人講咗 {r.evidence.patientMessages} 句
                        {r.evidence.lastStaffMessageAt ? ` · 最後覆 ${mdhm(r.evidence.lastStaffMessageAt)}` : ""}
                      </div>
                    )}
                    {r.salesNote && <div className="text-[11px] text-t1 mt-0.5">銷售補充：{r.salesNote}</div>}
                  </td>
                  <td className="px-4 py-2">{r.salesStaffName ?? (r.salesApricotUserId ? <span className="text-t3">未綁 inbox 帳號</span> : "—")}</td>
                  <td className="px-4 py-2">
                    {r.conversationId ? (
                      <a className="text-brand-text hover:underline" href={`/inbox?conv=${encodeURIComponent(r.conversationId)}`}>
                        {r.patientCode ?? r.patientApricotId?.slice(-8) ?? "對話"}
                      </a>
                    ) : (
                      <span className="text-xs">{r.patientCode ?? r.patientApricotId?.slice(-8) ?? "—"}</span>
                    )}
                    {r.patientName && <span className="ml-1.5 text-t3 text-xs">{r.patientName}</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.amount == null ? "—" : r.amount.toLocaleString("en-HK")}</td>
                  <td className="px-4 py-2">
                    {r.status === "OPEN" && r.kind === "INVOICE_EDITED" ? (
                      <div className="flex justify-end">
                        <button disabled={busy === r.id} onClick={() => void decide(r.id, "ACKNOWLEDGED")} className="rounded-full bg-brand text-panel text-xs font-semibold px-3 py-1.5 disabled:opacity-40" data-e2e="sales-review-ack">
                          已知悉
                        </button>
                      </div>
                    ) : r.status === "OPEN" ? (
                      <div className="flex flex-col items-end gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <input
                            aria-label="批幾多 %"
                            inputMode="decimal"
                            placeholder="100"
                            className={`${inputCls} w-16 text-right text-xs`}
                            value={pct[r.id] ?? ""}
                            onChange={(e) => setPct({ ...pct, [r.id]: e.target.value })}
                          />
                          <span className="text-xs text-t3">%</span>
                          <button disabled={busy === r.id} onClick={() => void decide(r.id, "APPROVED")} className="rounded-full bg-brand text-panel text-xs font-semibold px-3 py-1.5 disabled:opacity-40">
                            批
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            aria-label="拒絕原因"
                            placeholder="拒絕原因"
                            maxLength={500}
                            className={`${inputCls} w-40 text-xs`}
                            value={note[r.id] ?? ""}
                            onChange={(e) => setNote({ ...note, [r.id]: e.target.value })}
                          />
                          <button
                            disabled={busy === r.id}
                            onClick={() => void decide(r.id, "REJECTED")}
                            className="rounded-full border border-line-strong bg-panel text-t1 text-xs px-3 py-1.5 hover:bg-panel-2 disabled:opacity-40"
                          >
                            拒
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-right text-xs">
                        <span className={`px-2 py-0.5 rounded-full font-semibold ${r.status === "APPROVED" ? "bg-brand-soft text-brand-text" : "bg-panel-2 text-t2"}`}>
                          {REVIEW_STATUS[r.status]}
                          {r.status === "APPROVED" && r.approvedPct != null ? ` ${r.approvedPct}%` : ""}
                        </span>
                        {r.note && <div className="text-t3 mt-1">{r.note}</div>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-t3 text-sm">
                    冇需要對嘅單
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

interface CommissionRow {
  staffId: string;
  name: string;
  active: boolean;
  counted: number;
  held: number;
  excluded: number;
  rejected: number;
  lines: number;
}
interface LedgerLine {
  id: string;
  kind: string;
  status: string;
  billCode: string | null;
  paidAt: string;
  paymentAmt: number;
  ratePct: number;
  commissionAmt: number;
  approvedPct: number | null;
  countedAmt: number;
  patientCode: string | null;
  patientName: string | null;
  conversationId: string | null;
}
const LEDGER_STATUS: Record<string, string> = { COUNTED: "已計", HELD: "等批", EXCLUDED: "離職後", REJECTED: "已拒" };
const hkNowMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const hkd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-HK", { maximumFractionDigits: 2 })}`;

/** 老闆：當月每個銷售傭金合計；撳一行睇明細（每筆付款） */
function CommissionTab() {
  const [month, setMonth] = useState(hkNowMonth());
  const [rows, setRows] = useState<CommissionRow[] | null>(null);
  const [closed, setClosed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<LedgerLine[] | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setMsg(null);
    setOpen(null);
    const r = await api<{ rows: CommissionRow[]; closed: boolean; error?: string }>(`/api/admin/sales/commission?month=${month}`);
    if (r.ok) {
      setRows(r.data.rows);
      setClosed(r.data.closed);
      if (r.data.error) setMsg(r.data.error);
    } else setMsg(r.error);
  }, [month]);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(staffId: string) {
    if (open === staffId) return setOpen(null);
    setOpen(staffId);
    setLines(null);
    const r = await api<{ ledger: { rows: LedgerLine[] } }>(`/api/admin/sales/commission/${encodeURIComponent(staffId)}?month=${month}`);
    if (r.ok) setLines(r.data.ledger.rows);
    else setMsg(r.error);
  }

  const total = (rows ?? []).reduce((n, r) => n + r.counted, 0);
  return (
    <div className="space-y-4">
      <div className={`${card} flex flex-wrap items-center gap-3`}>
        <input type="month" aria-label="月份" className={inputCls} value={month} max={hkNowMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        <span className="text-sm text-t1 font-semibold tabular-nums">合計 {hkd(total)}</span>
        {closed && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-panel-2 text-t2">已月結</span>}
        <span className="text-xs text-t3">傭金跟每筆付款計（每晚同步，每張單一次）；「等批」= 對單／冇打卡申訴未批；付款作廢會扣回。</span>
      </div>
      {msg && <p className="text-sm text-danger-text">{msg}</p>}
      {!rows ? (
        <WLoading />
      ) : (
        <div className="overflow-x-auto bg-panel rounded-[22px] border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-t2">
              <tr>
                <th className="px-4 py-2.5 text-[11px] font-semibold">銷售</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">已計</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">等批</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">離職後</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">已拒</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">筆數</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.staffId}>
                  <tr className="border-b border-line last:border-0 cursor-pointer hover:bg-panel-2" onClick={() => void toggle(r.staffId)} data-e2e="sales-commission-row">
                    <td className="px-4 py-2">
                      {r.name}
                      {!r.active && <span className="ml-1.5 text-[11px] text-t3">（已停用）</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">{hkd(r.counted)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.held ? hkd(r.held) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.excluded ? hkd(r.excluded) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.rejected ? hkd(r.rejected) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.lines}</td>
                  </tr>
                  {open === r.staffId && (
                    <tr className="border-b border-line bg-panel-2/50">
                      <td colSpan={6} className="px-4 py-2">
                        {!lines ? (
                          <WLoading />
                        ) : lines.length === 0 ? (
                          <div className="text-xs text-t3 py-2">呢個月冇付款</div>
                        ) : (
                          <table className="w-full text-xs">
                            <tbody>
                              {lines.map((l) => (
                                <tr key={l.id} className="border-b border-line last:border-0">
                                  <td className="py-1.5 tabular-nums">{md(l.paidAt)}</td>
                                  <td className="py-1.5">
                                    {l.conversationId ? (
                                      <a className="text-brand-text hover:underline" href={`/inbox?conv=${encodeURIComponent(l.conversationId)}`}>
                                        {l.patientCode ?? "病人"}
                                      </a>
                                    ) : (
                                      (l.patientCode ?? "病人")
                                    )}
                                    {l.patientName && <span className="ml-1 text-t3">{l.patientName}</span>}
                                  </td>
                                  <td className="py-1.5 tabular-nums">{l.billCode ?? "—"}</td>
                                  <td className="py-1.5 tabular-nums text-right">{l.kind === "CLAWBACK" ? "作廢扣回" : hkd(l.paymentAmt)}</td>
                                  <td className="py-1.5 tabular-nums text-right">{l.ratePct}%{l.approvedPct != null && l.approvedPct !== 100 ? ` × ${l.approvedPct}%` : ""}</td>
                                  <td className="py-1.5 tabular-nums text-right font-medium">{hkd(l.status === "COUNTED" ? l.countedAmt : l.commissionAmt)}</td>
                                  <td className="py-1.5 text-right text-t3">{LEDGER_STATUS[l.status] ?? l.status}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-t3 text-sm">
                    未有銷售人員
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

interface CloseRow {
  inboxStaffId: string;
  name: string;
  active: boolean;
  earned: number;
  carryIn: number;
  net: number;
  payout: number;
  carryOut: number;
  lines: number;
  held: number;
  payrollStatus?: string;
  payrollMonth?: string | null;
}
interface RunInfo {
  status: string;
  trigger: string;
  checked: number;
  requests: number;
  stopReason: string | null;
  startedAt: string;
  finishedAt: string | null;
}
interface CloseView {
  month: string;
  closed: boolean;
  closedAt: string | null;
  forced: boolean;
  blockers: { code: string; message: string }[];
  preClose: { ok: boolean; status: string | null; finishedAt: string | null; running: boolean };
  sync: { running: RunInfo | null; last: RunInfo | null };
  rows: CloseRow[];
  heldLines: number;
}
const PAYROLL_TEXT: Record<string, string> = { ADDED: "已入計糧", NONE: "冇出糧", NO_EMPLOYEE: "未綁員工 — 要人手", MANUAL: "已離職 — 離職結算人手處理" };
const prevMonth = () => {
  const d = new Date(Date.now() + 8 * 3600_000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

/** 老闆月結：預覽 → 月結前同步 → 確認月結（出糧入 workforce 計糧調整；負數結轉）→ 報表 CSV；可重開 */
function CloseTab() {
  const [month, setMonth] = useState(prevMonth());
  const [view, setView] = useState<CloseView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setMsg(null);
    const r = await api<CloseView>(`/api/admin/sales/month-close?month=${month}`);
    if (r.ok) setView(r.data);
    else {
      setView(null);
      setMsg(r.error);
    }
  }, [month]);
  useEffect(() => {
    setView(null);
    void load();
  }, [load]);
  // 同步緊 → 每 15 秒睇吓完未
  useEffect(() => {
    if (!view?.sync.running && !view?.preClose.running) return;
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, [view?.sync.running, view?.preClose.running, load]);

  async function act(url: string, body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    const r = await api<Record<string, unknown>>(url, { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    setMsg(r.ok ? ok : r.error);
    await load();
  }
  async function close() {
    if (!view) return;
    const total = view.rows.reduce((n, r) => n + r.payout, 0);
    let force = false;
    if (!view.preClose.ok) {
      if (!window.confirm("未做月結前同步（或者上次未完成）— 可能漏咗最近嘅付款／作廢。確定照結？")) return;
      force = true;
    } else if (!window.confirm(`確定結 ${view.month}？出糧合共 ${hkd(total)} 會入 workforce 計糧調整。`)) return;
    await act("/api/admin/sales/month-close", { month: view.month, force }, `${view.month} 已月結`);
  }
  async function reopen() {
    if (!view || !window.confirm(`重開 ${view.month}？已入嘅計糧調整會刪走（審計睇得返）。`)) return;
    await act("/api/admin/sales/month-close/reopen", { month: view.month }, `${view.month} 已重開`);
  }

  const total = (view?.rows ?? []).reduce((n, r) => n + r.payout, 0);
  const run = view?.sync.running ?? view?.sync.last ?? null;
  return (
    <div className="space-y-4">
      <div className={`${card} flex flex-wrap items-center gap-3`}>
        <input type="month" aria-label="月份" className={inputCls} value={month} max={hkNowMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        {view && (
          <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${view.closed ? "bg-brand-soft text-brand-text" : "bg-panel-2 text-t2"}`}>
            {view.closed ? `已月結${view.forced ? "（冇同步照結）" : ""}` : "未月結"}
          </span>
        )}
        <span className="text-sm text-t1 font-semibold tabular-nums">出糧合共 {hkd(total)}</span>
        <a href={`/api/admin/sales/report?month=${month}`} className="ml-auto rounded-full border border-line-strong bg-panel text-t1 text-xs px-3 py-1.5 hover:bg-panel-2" data-e2e="sales-report-csv">
          下載報表 CSV
        </a>
      </div>

      {view && !view.closed && (
        <div className={`${card} flex flex-wrap items-center gap-3 text-sm`}>
          <div className="min-w-0">
            <div className="font-semibold text-t1">月結前同步</div>
            <div className="text-xs text-t3">
              {view.sync.running
                ? `同步緊…（已查 ${view.sync.running.checked} 張單）`
                : view.preClose.ok
                  ? `已完成（${mdhm(view.preClose.finishedAt)}）`
                  : run
                    ? `未做（上次：${run.trigger === "PRE_CLOSE" ? "月結前" : "每晚"} ${run.status}${run.stopReason ? ` · ${run.stopReason}` : ""} · ${mdhm(run.finishedAt ?? run.startedAt)}）`
                    : "未做"}
              {" "}— 全部追蹤緊嘅單慢慢查一次（每張單一次，唔似攻擊），可能要幾十分鐘
            </div>
          </div>
          <button
            disabled={busy || !!view.sync.running}
            onClick={() => void act("/api/admin/sales/commission-sync", {}, "已開始同步 — 完成後會自動更新")}
            className="ml-auto rounded-full border border-line-strong bg-panel text-t1 text-xs px-3 py-1.5 hover:bg-panel-2 disabled:opacity-40"
            data-e2e="sales-preclose-sync"
          >
            月結前同步
          </button>
        </div>
      )}

      {msg && <p className="text-sm text-danger-text">{msg}</p>}
      {view?.blockers.map((b) => (
        <p key={b.code} className="text-sm text-t2">
          ⚠ {b.message}
        </p>
      ))}

      {!view ? (
        !msg && <WLoading />
      ) : (
        <div className="overflow-x-auto bg-panel rounded-[22px] border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-t2">
              <tr>
                <th className="px-4 py-2.5 text-[11px] font-semibold">銷售</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">當月已計</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">上月結轉</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">出糧</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">結轉下月</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-right">等批</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold">{view.closed ? "糧單" : "筆數"}</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.inboxStaffId} className="border-b border-line last:border-0" data-e2e="sales-close-row">
                  <td className="px-4 py-2">
                    {r.name}
                    {!r.active && <span className="ml-1.5 text-[11px] text-t3">（已停用）</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{hkd(r.earned)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.carryIn ? hkd(r.carryIn) : "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold">{hkd(r.payout)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.carryOut ? hkd(r.carryOut) : "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.held ? `${hkd(r.held)} → 下月` : "—"}</td>
                  <td className="px-4 py-2 text-xs">
                    {view.closed ? `${PAYROLL_TEXT[r.payrollStatus ?? ""] ?? r.payrollStatus ?? "—"}${r.payrollMonth && r.payrollMonth !== view.month ? `（${r.payrollMonth} 糧單）` : ""}` : r.lines}
                  </td>
                </tr>
              ))}
              {view.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-t3 text-sm">
                    呢個月冇傭金
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view && (
        <div className="flex flex-wrap items-center gap-3">
          {!view.closed ? (
            <button
              disabled={busy || view.blockers.length > 0 || !!view.sync.running}
              onClick={() => void close()}
              className="rounded-full bg-brand text-panel text-sm font-semibold px-4 py-2 disabled:opacity-40"
              data-e2e="sales-close-confirm"
            >
              確認月結 {view.month}
            </button>
          ) : (
            <button disabled={busy} onClick={() => void reopen()} className="rounded-full border border-line-strong bg-panel text-t1 text-sm px-4 py-2 hover:bg-panel-2 disabled:opacity-40" data-e2e="sales-close-reopen">
              重開 {view.month}
            </button>
          )}
          <span className="text-xs text-t3">
            出糧 &gt; 0 入 workforce 計糧調整（計 MPF）；負數唔扣底薪，結轉落下個月；等批嘅帶落下個月，批咗先計；嗰個月糧單已確認就入下個月。
            嗰個月嘅計糧草稿如果已經生成，要喺 workforce 重新生成先會見到傭金。
          </span>
        </div>
      )}
    </div>
  );
}
