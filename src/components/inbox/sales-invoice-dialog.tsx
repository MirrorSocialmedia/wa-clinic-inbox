"use client";

/**
 * ★ cwi-sales 第 2 期：對話右欄「開單」對話框。
 *
 * - 名單（醫生、收費項目 + 傭金 %、付款方式）由 workforce 每晚更新嘅本地名單拎 — 唔使等 Apricot
 * - 一個對話框 = 一個一次性開單編號（requestKey）；內容一改就換新編號（未送出嘅編號冇副作用）
 * - 送出後「未確認／處理中／Apricot 忙」→ 鎖住表格，只可以用同一編號「再試」（workforce 先搜 Apricot，唔會開兩張）
 * - 開到 → 顯示 invoice 編號；保護外病人 → 提示入咗老闆對單
 * - 未確認嘅單記喺 localStorage（每個對話一張）：關咗對話框再開 → 只會提你用返同一張單再試，唔會開多張
 *   （server 都會將同內容未確認嘅單接返 — 呢度係 UX，唔係唯一防線）
 * - ★ 第 5 期（U9）：冇 conversationId → 先搜病人（walk-in／前台轉介），之後同一張表格，送去 /api/sales/invoice
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Receipt, Trash2, X } from "lucide-react";

interface InvoicePatient {
  patientApricotId: string;
  code: string | null;
  name: string | null;
  ownership: "MINE_PROTECTED" | "MINE_BOUND" | "NONE" | "OTHER";
  ownerName: string | null;
}
interface Options {
  clinicCode: string;
  writeEnabled: boolean;
  templateReady: boolean;
  practitioners: { extId: string; name: string; nameChi: string | null }[];
  feeItems: { extId: string; code: string; des: string; fee: number; ratePct: number | null; highValue?: boolean }[];
  paymentMethods: { extId: string; code: string; des: string }[];
}
interface Loaded {
  context: { blocked: string | null; clinicCode: string | null; clinics?: { code: string; name: string }[]; patients: InvoicePatient[]; clinicNote?: string | null };
  options: Options | null;
  optionsError: string | null;
}
interface Line {
  key: number;
  feeItemExtId: string;
  qty: string;
  up: string;
  discAmt: string;
  remarks: string;
}
interface Created {
  billCode: string | null;
  totalAmt: number;
  paymentAmt: number;
  commissionableAmt: number;
  review: boolean;
  replayed: boolean;
  recovered: boolean;
  bound: boolean;
  highValueExtended?: boolean;
}

/** 送出後要用同一編號再試嘅錯誤（未知結果／處理中） */
const PENDING_CODES = new Set(["UNCONFIRMED", "IN_PROGRESS", "APRICOT_BUSY", "SEARCH_FAILED", "APRICOT_UNAVAILABLE", "TOO_MANY_ATTEMPTS"]);

const OWNERSHIP_TEXT: Record<InvoicePatient["ownership"], string> = {
  MINE_PROTECTED: "你保護中",
  MINE_BOUND: "你綁定",
  NONE: "冇人負責 · 會入老闆對單",
  OTHER: "其他銷售負責",
};

interface PendingStored {
  requestKey: string;
  body: Record<string, unknown>;
  at: number;
}
const pendingKey = (conversationId: string) => `wa:sales-invoice-pending:${conversationId}`;
function readPending(conversationId: string): PendingStored | null {
  try {
    const raw = window.localStorage.getItem(pendingKey(conversationId));
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingStored;
    if (!p?.requestKey || !p.body || Date.now() - p.at > 86_400_000) return null;
    return p;
  } catch {
    return null;
  }
}
function writePending(conversationId: string, p: PendingStored | null): void {
  try {
    if (p) window.localStorage.setItem(pendingKey(conversationId), JSON.stringify(p));
    else window.localStorage.removeItem(pendingKey(conversationId));
  } catch {
    /* 私人模式等 — server 端仍然會接返同內容嘅單 */
  }
}

function newKey(): string {
  const c = globalThis.crypto;
  return c?.randomUUID ? c.randomUUID().replace(/-/g, "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const num = (s: string) => (s.trim() === "" ? 0 : Number(s));
const cents = (s: string) => Math.round(num(s) * 100);
const okMoney = (s: string) => s.trim() === "" || (/^\d+(\.\d{1,2})?$/.test(s.trim()) && Number(s) <= 10_000_000);

interface SearchHit {
  patientApricotId: string;
  patientCode: string;
  patientName: string;
  clinicLabel?: string;
}

export function SalesInvoiceDialog({ conversationId, onClose, onCreated }: { conversationId?: string | null; onClose: () => void; onCreated?: () => void }) {
  // ★ U9：冇對話 → 揀病人（搜尋）先
  const [directPid, setDirectPid] = useState<string | null>(null);
  const [sq, setSq] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const storeKey = conversationId ?? (directPid ? `direct-${directPid}` : null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pid, setPid] = useState("");
  const [practId, setPractId] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState("");
  const [payAmt, setPayAmt] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const keyRef = useRef(newKey());
  const lineSeq = useRef(0);
  /** 上次未確認嘅單（localStorage 還原）— 再試一定用返佢嘅編號同內容 */
  const [restored, setRestored] = useState<PendingStored | null>(null);
  /** ★ 第 5 期（R6）：揀開單分店（"" = 預設：對話處理中分店） */
  const [clinicPick, setClinicPick] = useState("");

  useEffect(() => {
    if (!storeKey) return;
    const p = readPending(storeKey);
    if (p) {
      setRestored(p);
      setPendingCode("UNCONFIRMED");
    }
  }, [storeKey]);

  async function searchPatients() {
    const q = sq.trim();
    if (q.length < 2 || searching) return;
    setSearching(true);
    setSearchErr(null);
    try {
      const res = await fetch(`/api/sales/patient-search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const j = (await res.json().catch(() => null)) as { patients?: SearchHit[]; message?: string } | null;
      if (!res.ok || !j?.patients) setSearchErr(j?.message ?? "搜唔到");
      else setHits(j.patients);
    } catch {
      setSearchErr("網絡錯誤");
    } finally {
      setSearching(false);
    }
  }

  const getUrl = conversationId
    ? `/api/conversations/${conversationId}/sales/invoice${clinicPick ? `?clinicCode=${encodeURIComponent(clinicPick)}` : ""}`
    : directPid
      ? `/api/sales/invoice?patientApricotId=${encodeURIComponent(directPid)}${clinicPick ? `&clinicCode=${encodeURIComponent(clinicPick)}` : ""}`
      : null;
  const postUrl = conversationId ? `/api/conversations/${conversationId}/sales/invoice` : "/api/sales/invoice";

  useEffect(() => {
    if (!getUrl) return;
    let alive = true;
    setLoadErr(null);
    fetch(getUrl, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as (Loaded & { message?: string }) | null;
        if (!alive) return;
        if (!res.ok || !data) return setLoadErr(data?.message ?? "拎唔到開單資料");
        setLoaded(data);
        setPid((cur) => cur || (data.context.patients.find((p) => p.ownership !== "OTHER" && p.code)?.patientApricotId ?? ""));
        // 換店 → 醫生／項目／付款方式係每間店唔同 → 清返
        setPractId("");
        setLines([]);
        setPayMethod(data.options?.paymentMethods[0]?.extId ?? "");
      })
      .catch(() => alive && setLoadErr("網絡錯誤"));
    return () => {
      alive = false;
    };
  }, [getUrl]);

  const locked = !!pendingCode || !!created;
  /** 內容一改 → 換新編號（未送出／上次已確定失敗嘅編號唔再用） */
  const touch = useCallback(() => {
    if (!locked) keyRef.current = newKey();
  }, [locked]);

  const opts = loaded?.options ?? null;
  const feeOf = useMemo(() => new Map((opts?.feeItems ?? []).map((f) => [f.extId, f])), [opts]);
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!opts || !q) return [];
    return opts.feeItems.filter((f) => f.code.toLowerCase().includes(q) || f.des.toLowerCase().includes(q)).slice(0, 8);
  }, [opts, search]);

  const totals = useMemo(() => {
    let total = 0;
    let comm = 0;
    for (const l of lines) {
      const t = cents(l.up) * (Number.parseInt(l.qty, 10) || 0) - cents(l.discAmt);
      total += t;
      if ((feeOf.get(l.feeItemExtId)?.ratePct ?? 0) > 0) comm += t;
    }
    return { total: total / 100, comm: comm / 100 };
  }, [lines, feeOf]);

  const lineErrors = lines.map((l) => {
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) return "數量 1–999";
    if (!okMoney(l.up) || l.up.trim() === "") return "單價唔啱";
    if (!okMoney(l.discAmt)) return "折扣唔啱";
    if (cents(l.discAmt) > cents(l.up) * qty) return "折扣大過金額";
    return null;
  });
  const payErr = !okMoney(payAmt) ? "收款金額唔啱" : cents(payAmt) > Math.round(totals.total * 100) ? "收款大過總額" : cents(payAmt) > 0 && !payMethod ? "揀付款方式" : null;
  const patient = loaded?.context.patients.find((p) => p.patientApricotId === pid) ?? null;
  const canSubmit =
    !!opts && opts.writeEnabled && opts.templateReady && !loaded?.context.blocked && !!patient && patient.ownership !== "OTHER" && !!patient.code &&
    !!practId && lines.length > 0 && lineErrors.every((e) => !e) && !payErr && !busy && !created;

  function addLine(extId: string) {
    const f = feeOf.get(extId);
    if (!f) return;
    touch();
    setLines((ls) => [...ls, { key: ++lineSeq.current, feeItemExtId: extId, qty: "1", up: String(f.fee), discAmt: "", remarks: "" }]);
    setSearch("");
  }
  function updateLine(key: number, patch: Partial<Line>) {
    touch();
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit() {
    if (busy || created) return;
    if (!pendingCode && !canSubmit) return;
    setBusy(true);
    setErr(null);
    const body = restored
      ? { ...restored.body, requestKey: restored.requestKey }
      : {
          requestKey: keyRef.current,
          clinicCode: loaded?.context.clinicCode ?? null,
          patientApricotId: pid,
          practitionerExtId: practId,
          lines: lines.map((l) => ({ feeItemExtId: l.feeItemExtId, qty: Number(l.qty), up: num(l.up), discAmt: num(l.discAmt), remarks: l.remarks.trim() || null })),
          payment: cents(payAmt) > 0 ? { amt: num(payAmt), methodExtId: payMethod } : null,
        };
    try {
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { invoice?: Created; error?: string; message?: string } | null;
      if (res.ok && data?.invoice) {
        setCreated(data.invoice);
        setPendingCode(null);
        setRestored(null);
        if (storeKey) writePending(storeKey, null);
        onCreated?.();
        return;
      }
      const code = data?.error ?? "";
      setErr(data?.message ?? "開單失敗");
      // 未知結果 → 鎖表格，只准同一編號再試；確定失敗 → 解鎖（改內容會換新編號）
      const pending = PENDING_CODES.has(code) || res.status === 504;
      setPendingCode(pending ? code || "UNCONFIRMED" : null);
      if (pending && storeKey) writePending(storeKey, { requestKey: String(body.requestKey), body, at: restored?.at ?? Date.now() });
      else {
        if (storeKey) writePending(storeKey, null);
        if (restored) {
          setRestored(null);
          keyRef.current = newKey();
        }
      }
    } catch {
      // 網絡斷咗 = 唔知 server 有冇收到 → 當未確認
      setErr("網絡斷咗 — 唔知開咗未。請等 1 分鐘再撳「再試（同一張單）」，唔好重新開過");
      setPendingCode("UNCONFIRMED");
      if (storeKey) writePending(storeKey, { requestKey: String(body.requestKey), body, at: restored?.at ?? Date.now() });
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (busy) return;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="開 invoice" data-e2e="sales-invoice-dialog">
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-panel border border-line shadow-xl">
        <div className="sticky top-0 bg-panel flex items-center gap-2 px-4 py-3 border-b border-line">
          <Receipt className="w-4 h-4 text-brand-text" aria-hidden />
          <div className="font-semibold text-sm">開 invoice{loaded?.context.clinicCode ? ` · ${loaded.context.clinicCode}` : ""}</div>
          <button type="button" onClick={close} className="ml-auto p-1 rounded-full hover:bg-panel-2" aria-label="關閉">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3 text-sm">
          {!conversationId && !directPid && (
            <div className="flex flex-col gap-2" data-e2e="sales-invoice-direct-search">
              <div className="text-xs text-t2">冇 WhatsApp 對話嘅病人（walk-in／前台轉介）— 先搜病人</div>
              <div className="flex gap-1.5">
                <input
                  value={sq}
                  onChange={(e) => setSq(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void searchPatients();
                  }}
                  placeholder="病人編號／姓名／電話"
                  className="flex-1 min-w-0 rounded-xl bg-panel-2 border border-line px-3 py-2 text-sm"
                  data-e2e="sales-invoice-direct-q"
                />
                <button type="button" disabled={searching || sq.trim().length < 2} onClick={() => void searchPatients()} className="text-xs px-3 rounded-full bg-brand text-panel disabled:opacity-50">
                  {searching ? "搜緊…" : "搜尋"}
                </button>
              </div>
              {searchErr && <div className="text-xs text-danger-text">{searchErr}</div>}
              {hits && hits.length === 0 && <div className="text-xs text-t3">搵唔到病人</div>}
              {hits && hits.length > 0 && (
                <ul className="rounded-xl border border-line divide-y divide-line max-h-64 overflow-y-auto">
                  {hits.map((h) => (
                    <li key={h.patientApricotId}>
                      <button type="button" onClick={() => setDirectPid(h.patientApricotId)} className="w-full text-left px-3 py-2 text-xs hover:bg-panel-2 flex items-center gap-2" data-e2e="sales-invoice-direct-hit">
                        <span className="text-t3">{h.patientCode}</span>
                        <span className="min-w-0 truncate">{h.patientName}</span>
                        {h.clinicLabel && <span className="ml-auto text-t3 shrink-0">{h.clinicLabel}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {getUrl && !loaded && !loadErr && <div className="text-t3 text-xs">載入緊…</div>}
          {loadErr && <div className="text-danger-text text-xs">{loadErr}</div>}
          {loaded?.context.clinicNote && !loaded.context.blocked && (
            <div className="rounded-xl bg-warn-soft border border-line px-3 py-2 text-xs text-warn-text" data-e2e="sales-invoice-clinic-note">{loaded.context.clinicNote}</div>
          )}
          {loaded?.context.blocked && <div className="rounded-xl bg-panel-2 border border-line px-3 py-2 text-xs text-t1" data-e2e="sales-invoice-blocked">{loaded.context.blocked}</div>}
          {loaded && !loaded.context.blocked && loaded.optionsError && <div className="text-danger-text text-xs">{loaded.optionsError}</div>}
          {opts && !opts.writeEnabled && <div className="rounded-xl bg-panel-2 border border-line px-3 py-2 text-xs text-t1">開單功能未開通（老闆喺 Apricot 試開核對之後先開）— 而家可以睇，唔可以送出</div>}
          {opts && !opts.templateReady && <div className="rounded-xl bg-panel-2 border border-line px-3 py-2 text-xs text-t1">呢間店未有開單範本 — 請老闆喺「銷售」設定撳「立即更新名單」</div>}

          {created ? (
            <div className="flex flex-col gap-2" data-e2e="sales-invoice-created">
              <div className="text-base font-semibold">
                {created.billCode ?? "已開單"} · {money(created.totalAmt)}
              </div>
              <div className="text-xs text-t2">
                {created.paymentAmt > 0 ? `即場收咗 ${money(created.paymentAmt)}` : "未收錢（之後前台喺 Apricot 收都計）"}
                {created.commissionableAmt > 0 ? ` · 傭金項目 ${money(created.commissionableAmt)}` : " · 冇傭金項目"}
              </div>
              {created.recovered && <div className="text-xs text-t2">上次逾時但其實已經開咗 — 系統搵返呢張，冇開多張</div>}
              {created.replayed && !created.recovered && <div className="text-xs text-t2">呢張單之前已經開咗（冇重複開）</div>}
              {created.bound && <div className="text-xs text-brand-text">病人已轉為你嘅綁定病人</div>}
              {created.highValueExtended && <div className="text-xs text-brand-text">有高價項目 — 保護期已延長（高價項目保護期）</div>}
              {created.review && <div className="text-xs text-t1">呢個病人唔喺你保護之下 — 已入老闆對單，批咗先計傭金</div>}
              <button type="button" onClick={onClose} className="mt-1 text-xs py-2 rounded-full bg-brand text-panel font-medium">
                完成
              </button>
            </div>
          ) : (
            opts &&
            !loaded?.context.blocked && (
              <fieldset disabled={locked || busy} className="flex flex-col gap-3 min-w-0">
                {(loaded?.context.clinics?.length ?? 0) > 1 && (
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-t3">開單分店（病人喺邊間店做就揀邊間）</span>
                    <select
                      value={clinicPick || loaded!.context.clinicCode || ""}
                      onChange={(e) => { touch(); setClinicPick(e.target.value); }}
                      className="rounded-xl bg-panel-2 border border-line px-3 py-2 text-sm"
                      data-e2e="sales-invoice-clinic"
                    >
                      {loaded!.context.clinics!.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code} · {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-t3">病人</span>
                  <select value={pid} onChange={(e) => { touch(); setPid(e.target.value); }} className="rounded-xl bg-panel-2 border border-line px-3 py-2 text-sm" data-e2e="sales-invoice-patient">
                    <option value="">揀病人…</option>
                    {loaded!.context.patients.map((p) => (
                      <option key={p.patientApricotId} value={p.patientApricotId} disabled={p.ownership === "OTHER" || !p.code}>
                        {p.code ?? "（冇編號）"} {p.name ?? ""} · {p.ownership === "OTHER" ? `${p.ownerName ?? "其他銷售"} 負責` : OWNERSHIP_TEXT[p.ownership]}
                      </option>
                    ))}
                  </select>
                  {patient?.ownership === "NONE" && <span className="text-[11px] text-t2">呢個病人冇人負責 — 張單會入老闆對單，批咗先計傭金</span>}
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-t3">醫生（{opts.clinicCode} 出診）</span>
                  <select value={practId} onChange={(e) => { touch(); setPractId(e.target.value); }} className="rounded-xl bg-panel-2 border border-line px-3 py-2 text-sm" data-e2e="sales-invoice-doctor">
                    <option value="">揀醫生…</option>
                    {opts.practitioners.map((p) => (
                      <option key={p.extId} value={p.extId}>
                        {p.nameChi ?? p.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-t3">項目</span>
                  {lines.map((l, i) => {
                    const f = feeOf.get(l.feeItemExtId);
                    return (
                      <div key={l.key} className="rounded-xl border border-line bg-panel-2 p-2.5 flex flex-col gap-1.5" data-e2e="sales-invoice-line">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium min-w-0 truncate">
                            {f?.code} {f?.des}
                          </span>
                          {(f?.ratePct ?? 0) > 0 && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-brand-soft text-brand-text">傭金 {f!.ratePct}%</span>}
                          {f?.highValue && (f.ratePct ?? 0) > 0 && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-panel border border-line text-t1">高價</span>}
                          <button type="button" onClick={() => { touch(); setLines((ls) => ls.filter((x) => x.key !== l.key)); }} className="ml-auto p-1 rounded-full hover:bg-panel" aria-label="刪除項目">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          <label className="flex flex-col text-[10px] text-t3">
                            數量
                            <input inputMode="numeric" value={l.qty} onChange={(e) => updateLine(l.key, { qty: e.target.value })} className="rounded-lg bg-panel border border-line px-2 py-1 text-sm text-t1" />
                          </label>
                          <label className="flex flex-col text-[10px] text-t3">
                            單價
                            <input inputMode="decimal" value={l.up} onChange={(e) => updateLine(l.key, { up: e.target.value })} className="rounded-lg bg-panel border border-line px-2 py-1 text-sm text-t1" />
                          </label>
                          <label className="flex flex-col text-[10px] text-t3">
                            折扣 $
                            <input inputMode="decimal" value={l.discAmt} placeholder="0" onChange={(e) => updateLine(l.key, { discAmt: e.target.value })} className="rounded-lg bg-panel border border-line px-2 py-1 text-sm text-t1" />
                          </label>
                        </div>
                        <input value={l.remarks} maxLength={200} placeholder="備註（例：#25-#27）" onChange={(e) => updateLine(l.key, { remarks: e.target.value })} className="rounded-lg bg-panel border border-line px-2 py-1 text-xs" />
                        {lineErrors[i] && <span className="text-[11px] text-danger-text">{lineErrors[i]}</span>}
                      </div>
                    );
                  })}
                  <div className="relative">
                    <div className="flex items-center gap-2 rounded-xl bg-panel-2 border border-line px-3 py-2">
                      <Plus className="w-3.5 h-3.5 text-t3" aria-hidden />
                      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搵收費項目（編號／名稱）" className="flex-1 bg-transparent text-sm outline-none" data-e2e="sales-invoice-search" />
                    </div>
                    {matches.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-1 z-10 rounded-xl border border-line bg-panel shadow-lg max-h-56 overflow-y-auto">
                        {matches.map((f) => (
                          <button key={f.extId} type="button" onClick={() => addLine(f.extId)} className="w-full text-left px-3 py-2 text-xs hover:bg-panel-2 flex items-center gap-2" data-e2e="sales-invoice-fee-option">
                            <span className="text-t3">{f.code}</span>
                            <span className="min-w-0 truncate">{f.des}</span>
                            <span className="ml-auto text-t2">{money(f.fee)}</span>
                            {(f.ratePct ?? 0) > 0 && <span className="text-[10px] text-brand-text">{f.ratePct}%{f.highValue ? " · 高價" : ""}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-t2">總額</span>
                  <span className="font-semibold" data-e2e="sales-invoice-total">{money(totals.total)}</span>
                </div>
                <div className="text-[11px] text-t3 -mt-2">傭金項目 {money(totals.comm)} · 傭金跟之後每筆付款計</div>

                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-t3">即場收款（可留空，冇最低）</span>
                  <div className="flex gap-1.5">
                    <input inputMode="decimal" value={payAmt} placeholder="$0" onChange={(e) => { touch(); setPayAmt(e.target.value); }} className="flex-1 min-w-0 rounded-xl bg-panel-2 border border-line px-3 py-2 text-sm" data-e2e="sales-invoice-pay" />
                    <select value={payMethod} onChange={(e) => { touch(); setPayMethod(e.target.value); }} className="rounded-xl bg-panel-2 border border-line px-2 py-2 text-sm">
                      {opts.paymentMethods.length === 0 && <option value="">（未有付款方式）</option>}
                      {opts.paymentMethods.map((m) => (
                        <option key={m.extId} value={m.extId}>
                          {m.des}
                        </option>
                      ))}
                    </select>
                  </div>
                  {payErr && <span className="text-[11px] text-danger-text">{payErr}</span>}
                  {/* ★ 第 5 期（U5）：唔使即場收 — 之後前台喺 Apricot 收嘅錢（同日或者之後）每晚同步都計傭金 */}
                  {!payErr && cents(payAmt) === 0 && <span className="text-[11px] text-t3">病人之後喺前台付款（同日或者之後）都計你傭金 — 每晚同步</span>}
                </div>
              </fieldset>
            )
          )}

          {err && <div className="text-xs text-danger-text" data-e2e="sales-invoice-error">{err}</div>}

          {!created && opts && !loaded?.context.blocked && (
            pendingCode ? (
              <div className="flex flex-col gap-1.5" data-e2e="sales-invoice-pending">
                {restored && (
                  <div className="rounded-xl bg-panel-2 border border-line px-3 py-2 text-xs text-t1">
                    上次（{new Date(restored.at).toLocaleString("zh-HK", { hour12: false })}）開嘅單未確認 — 請用返同一張單再試，唔好重新開過
                  </div>
                )}
                <div className="text-[11px] text-t2">張單可能已經開咗 — 只可以用同一張單再試（系統會先搜 Apricot，唔會開兩張）</div>
                <button type="button" disabled={busy} onClick={() => void submit()} className="text-xs py-2 rounded-full bg-brand text-panel font-medium disabled:opacity-50" data-e2e="sales-invoice-retry">
                  {busy ? "處理緊…" : "再試（同一張單）"}
                </button>
                {restored && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm("確定喺 Apricot 睇過冇開到呢張單？放棄之後可以重新開一張。")) return;
                      if (storeKey) writePending(storeKey, null);
                      setRestored(null);
                      setPendingCode(null);
                      setErr(null);
                      keyRef.current = newKey();
                    }}
                    className="text-[11px] py-1.5 rounded-full border border-line text-t2 disabled:opacity-50"
                  >
                    我已經喺 Apricot 確認冇開到 — 放棄呢張
                  </button>
                )}
              </div>
            ) : (
              <button type="button" disabled={!canSubmit} onClick={() => void submit()} className="text-xs py-2 rounded-full bg-brand text-panel font-medium disabled:opacity-50" data-e2e="sales-invoice-submit">
                {busy ? "開緊單…（Apricot 可能要十幾秒）" : `開 invoice · ${money(totals.total)}`}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
