"use client";

/**
 * ★ cwi-sales 第 3 期：我的銷售（client）— GET /api/sales/mine?month=
 * 傭金跟每筆付款計（每晚同步）；HELD = 等老闆批（對單／冇打卡申訴）；月結（第 4 期）先入糧單。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { WLoading } from "@/components/ui/w-loader";
import { SalesInvoiceDialog } from "@/components/inbox/sales-invoice-dialog";

interface Row {
  id: string;
  kind: string;
  status: string;
  billCode: string | null;
  paymentCode: string | null;
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
interface Invoice {
  invoiceId: string;
  billCode: string | null;
  createdAt: string;
  totalAmt: number;
  paidAmt: number;
  osAmt: number | null;
  isVoid: boolean;
  commission: number;
  held: number;
  patientCode: string | null;
  patientName: string | null;
  conversationId: string | null;
}
interface MyPatient {
  patientApricotId: string;
  state: "PROTECTED" | "BOUND";
  protectedUntil: string | null;
  lastApptDate: string | null;
  rounds: number;
  noShowStreak: number;
  highValue: boolean;
  daysLeft: number | null;
  intent: string | null;
  patientCode: string | null;
  patientName: string | null;
  conversationId: string | null;
}
interface PoolPatient {
  patientApricotId: string;
  wasMine: boolean;
  since: string;
  patientCode: string | null;
  patientName: string | null;
  conversationId: string | null;
}
interface Review {
  id: string;
  kind: string;
  kindLabel: string;
  status: string;
  apricotBillCode: string | null;
  amount: number | null;
  approvedPct: number | null;
  note: string | null;
  salesNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  patientCode: string | null;
  conversationId: string | null;
}
interface Data {
  month: string;
  counts: { protected: number; bound: number };
  ledger: { closed: boolean; totals: { counted: number; held: number; excluded: number; rejected: number; lines: number }; rows: Row[] };
  invoices: Invoice[];
  patients?: MyPatient[];
  pool?: PoolPatient[];
  /** null = workforce 拎唔到（唔阻成頁） */
  reviews?: Review[] | null;
}

const REVIEW_STATUS: Record<string, string> = { OPEN: "等老闆決定", APPROVED: "已批", REJECTED: "已拒", ACKNOWLEDGED: "老闆已知悉" };

/** 銷售補充原因（只限未決定） */
function ReviewNote({ r, onSaved }: { r: Review; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(r.salesNote ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (r.status !== "OPEN") return r.salesNote ? <div className="text-[11px] text-t3 mt-0.5">你補充：{r.salesNote}</div> : null;
  if (!open)
    return (
      <div className="mt-0.5 flex items-center gap-2">
        {r.salesNote && <span className="text-[11px] text-t3 truncate">你補充：{r.salesNote}</span>}
        <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-brand-text hover:underline shrink-0" data-e2e="sales-review-note-open">
          {r.salesNote ? "改補充" : "補充原因"}
        </button>
      </div>
    );
  return (
    <div className="mt-1 flex flex-col gap-1">
      <textarea value={text} maxLength={500} rows={2} onChange={(e) => setText(e.target.value)} placeholder="例：嗰日喺另一間店跟病人，之後過嚟開單" className="rounded-lg bg-panel-2 border border-line px-2 py-1 text-xs" data-e2e="sales-review-note-input" />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const res = await fetch(`/api/sales/reviews/${encodeURIComponent(r.id)}/note`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: text.trim() }) });
              const j = (await res.json().catch(() => null)) as { message?: string } | null;
              if (!res.ok) setMsg(j?.message ?? "儲存唔到");
              else {
                setOpen(false);
                onSaved();
              }
            } catch {
              setMsg("網絡錯誤");
            } finally {
              setBusy(false);
            }
          }}
          className="text-[11px] px-3 py-1 rounded-full bg-brand text-panel disabled:opacity-50"
          data-e2e="sales-review-note-save"
        >
          {busy ? "儲存緊…" : "送畀老闆"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-t2">
          取消
        </button>
        {msg && <span className="text-[11px] text-danger-text">{msg}</span>}
      </div>
    </div>
  );
}

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-HK", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const md = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const nowMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const STATUS: Record<string, string> = { COUNTED: "已計", HELD: "等老闆批", EXCLUDED: "離職後唔計", REJECTED: "老闆拒" };

function Patient({ code, name, conv }: { code: string | null; name: string | null; conv: string | null }) {
  const label = code ?? "病人";
  return (
    <span className="min-w-0 truncate">
      {conv ? (
        <Link href={`/inbox?conv=${encodeURIComponent(conv)}`} className="text-brand-text hover:underline">
          {label}
        </Link>
      ) : (
        label
      )}
      {name && <span className="text-t3 ml-1">{name}</span>}
    </span>
  );
}

const INTENT_TEXT: Record<string, string> = { HIGH: "高", MEDIUM: "中", LOW: "低" };
type PatientFilter = "ALL" | "PROTECTED" | "BOUND" | "EXPIRING" | "HIGH" | "MEDIUM" | "LOW";
const FILTERS: [PatientFilter, string][] = [
  ["ALL", "全部"],
  ["EXPIRING", "就到期"],
  ["PROTECTED", "保護中"],
  ["BOUND", "綁定"],
  ["HIGH", "意向高"],
  ["MEDIUM", "意向中"],
  ["LOW", "意向低"],
];
type PatientSort = "default" | "intent" | "expiry";
const PATIENT_SORTS: [PatientSort, string][] = [
  ["default", "預設"],
  ["intent", "意向高先"],
  ["expiry", "就到期先"],
];
const SORT_KEY = "wa:sales-mine:patient-sort";
const INTENT_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const INTENT_CHIP_CLS: Record<string, string> = {
  HIGH: "bg-danger-soft text-danger-text font-semibold",
  MEDIUM: "bg-warn-soft text-warn-text font-semibold",
  LOW: "bg-panel-2 text-t2",
};
/** 預設 = server 次序（保護中先、就到期先）；意向高先 → 同級就到期先；就到期先 → 綁定排尾 */
function sortPatients(list: MyPatient[], sort: PatientSort): MyPatient[] {
  if (sort === "default") return list;
  const exp = (p: MyPatient) => (p.state === "PROTECTED" && p.daysLeft != null ? p.daysLeft : Number.POSITIVE_INFINITY);
  const ir = (p: MyPatient) => (p.intent ? (INTENT_RANK[p.intent] ?? 3) : 3);
  return [...list].sort((a, b) => (sort === "intent" ? ir(a) - ir(b) || exp(a) - exp(b) : exp(a) - exp(b) || ir(a) - ir(b)));
}
function matchFilter(p: MyPatient, f: PatientFilter): boolean {
  if (f === "ALL") return true;
  if (f === "PROTECTED" || f === "BOUND") return p.state === f;
  if (f === "EXPIRING") return p.state === "PROTECTED" && p.daysLeft != null && p.daysLeft <= 3;
  return p.intent === f;
}

export default function SalesMineClient() {
  const [pf, setPf] = useState<PatientFilter>("ALL");
  const [psort, setPsort] = useState<PatientSort>("default");
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(SORT_KEY);
      if (v === "intent" || v === "expiry") setPsort(v);
    } catch {
      /* ignore */
    }
  }, []);
  const changeSort = (v: PatientSort) => {
    setPsort(v);
    try {
      window.localStorage.setItem(SORT_KEY, v);
    } catch {
      /* ignore */
    }
  };
  const [directOpen, setDirectOpen] = useState(false);
  const [month, setMonth] = useState(nowMonth());
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    setData(null);
    try {
      const res = await fetch(`/api/sales/mine?month=${month}`, { cache: "no-store" });
      const j = (await res.json().catch(() => null)) as (Data & { message?: string }) | null;
      if (!res.ok || !j) setErr(j?.message ?? "拎唔到資料");
      else setData(j);
    } catch {
      setErr("網絡錯誤");
    }
  }, [month]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="h-full overflow-y-auto">
      {directOpen && <SalesInvoiceDialog conversationId={null} onClose={() => setDirectOpen(false)} onCreated={() => void load()} />}
      <div className="max-w-3xl mx-auto px-4 py-5 space-y-4 pb-24">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-t1">我的銷售</h1>
          <button type="button" onClick={() => setDirectOpen(true)} className="text-xs px-3 py-1.5 rounded-full border border-line hover:bg-panel-2" data-e2e="sales-mine-direct-invoice">
            開單（冇對話病人）
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" aria-label="上個月" onClick={() => setMonth((m) => shiftMonth(m, -1))} className="p-1.5 rounded-full hover:bg-panel-2">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm tabular-nums w-[72px] text-center" data-e2e="sales-mine-month">{month}</span>
            <button type="button" aria-label="下個月" disabled={month >= nowMonth()} onClick={() => setMonth((m) => shiftMonth(m, 1))} className="p-1.5 rounded-full hover:bg-panel-2 disabled:opacity-30">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {err && <p className="text-sm text-danger-text">{err}</p>}
        {!data && !err && <WLoading />}
        {data && (
          <>
            <div className="grid grid-cols-3 gap-2.5">
              <div className="rounded-2xl bg-panel border border-line p-3.5" data-e2e="sales-mine-counted">
                <div className="text-xl font-semibold tabular-nums">{money(data.ledger.totals.counted)}</div>
                <div className="text-[11px] text-t3">{data.month === nowMonth() ? "本月傭金" : `${data.month} 傭金`}{data.ledger.closed ? "（已月結）" : ""}</div>
                {data.ledger.totals.held > 0 && <div className="text-[11px] text-t2 mt-1">另有 {money(data.ledger.totals.held)} 等老闆批</div>}
              </div>
              <div className="rounded-2xl bg-panel border border-line p-3.5">
                <div className="text-xl font-semibold tabular-nums">{data.counts.protected}</div>
                <div className="text-[11px] text-t3">保護中</div>
              </div>
              <div className="rounded-2xl bg-panel border border-line p-3.5">
                <div className="text-xl font-semibold tabular-nums">{data.counts.bound}</div>
                <div className="text-[11px] text-t3">綁定</div>
              </div>
            </div>

            {data.reviews === null && <p className="text-[11px] text-t3">暫時拎唔到對單結果 — 傭金數照常顯示</p>}
            {(data.reviews?.length ?? 0) > 0 && (
              <section className="rounded-2xl bg-panel border border-line" data-e2e="sales-mine-reviews">
                <div className="px-4 py-2.5 text-[11px] font-semibold text-t2 border-b border-line">
                  對單／扣起（{data.reviews!.filter((r) => r.status === "OPEN").length} 項等老闆）
                </div>
                <ul className="divide-y divide-line">
                  {data.reviews!.map((r) => (
                    <li key={r.id} className="px-4 py-2.5 text-sm" data-e2e="sales-mine-review">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="min-w-0 truncate font-medium">{r.kindLabel}</span>
                        <span className="shrink-0 text-[11px] text-t3">· {r.apricotBillCode ?? "—"}</span>
                        <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${r.status === "OPEN" ? "bg-brand-soft text-brand-text" : r.status === "REJECTED" ? "bg-panel-2 text-danger-text" : "bg-panel-2 text-t2"}`}>
                          {REVIEW_STATUS[r.status] ?? r.status}
                          {r.status === "APPROVED" && r.approvedPct != null && r.approvedPct !== 100 ? ` ${r.approvedPct}%` : ""}
                        </span>
                      </div>
                      <div className="text-[11px] text-t3">
                        {md(r.createdAt)} · <Patient code={r.patientCode} name={null} conv={r.conversationId} />
                        {r.amount != null ? ` · ${money(r.amount)}` : ""}
                      </div>
                      {r.note && <div className="text-[11px] text-t2 mt-0.5">老闆：{r.note}</div>}
                      <ReviewNote r={r} onSaved={() => void load()} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(data.patients?.length ?? 0) > 0 && (
              <section className="rounded-2xl bg-panel border border-line" data-e2e="sales-mine-patients">
                <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-t2 mr-1">我嘅病人</span>
                  {FILTERS.map(([k, l]) => {
                    const n = data.patients!.filter((p) => matchFilter(p, k)).length;
                    if (k !== "ALL" && n === 0) return null;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setPf(k)}
                        className={`text-[11px] px-2 py-0.5 rounded-full border ${pf === k ? "bg-brand text-panel border-brand" : "border-line text-t2 hover:bg-panel-2"}`}
                        data-e2e={`sales-mine-filter-${k}`}
                      >
                        {l} {n}
                      </button>
                    );
                  })}
                  <label className="ml-auto inline-flex items-center gap-1 text-[11px] text-t2">
                    排序
                    <select
                      value={psort}
                      onChange={(e) => changeSort(e.target.value as PatientSort)}
                      className="rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] text-t1"
                      data-e2e="sales-mine-sort"
                    >
                      {PATIENT_SORTS.map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <ul className="divide-y divide-line max-h-80 overflow-y-auto">
                  {sortPatients(data.patients!.filter((p) => matchFilter(p, pf)), psort).map((p) => (
                    <li key={p.patientApricotId} className="px-4 py-2 flex items-center gap-3 text-sm" data-e2e="sales-mine-patient">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Patient code={p.patientCode} name={p.patientName} conv={p.conversationId} />
                          {p.intent && INTENT_TEXT[p.intent] && (
                            <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${INTENT_CHIP_CLS[p.intent]}`} data-e2e="sales-mine-intent">
                              {INTENT_TEXT[p.intent]}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-t3">
                          {p.state === "BOUND" ? "綁定" : `保護中 · 第 ${p.rounds} 輪`}
                          {p.lastApptDate ? ` · 預約 ${p.lastApptDate.slice(5).replace("-", "/")}` : ""}
                          {p.highValue ? " · 高價" : ""}
                          {p.noShowStreak > 0 ? ` · 爽約 ${p.noShowStreak} 次` : ""}
                        </div>
                      </div>
                      {p.state === "PROTECTED" && p.daysLeft != null && (
                        <span className={`shrink-0 text-[11px] tabular-nums ${p.daysLeft <= 2 ? "text-danger-text font-medium" : "text-t2"}`}>{p.daysLeft === 0 ? "今日到期" : `${p.daysLeft} 日後到期`}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="rounded-2xl bg-panel border border-line">
              <div className="px-4 py-2.5 text-[11px] font-semibold text-t2 border-b border-line">{data.month} 傭金明細</div>
              {data.ledger.rows.length === 0 ? (
                <div className="px-4 py-5 text-sm text-t3 text-center">呢個月未有付款</div>
              ) : (
                <ul className="divide-y divide-line">
                  {data.ledger.rows.map((r) => (
                    <li key={r.id} className="px-4 py-2.5 flex items-center gap-3 text-sm" data-e2e="sales-mine-row">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Patient code={r.patientCode} name={r.patientName} conv={r.conversationId} />
                          <span className="shrink-0 text-[11px] text-t3">· {r.billCode ?? "—"}</span>
                        </div>
                        <div className="text-[11px] text-t3">
                          {md(r.paidAt)} · {r.kind === "CLAWBACK" ? "付款作廢 扣回" : `收款 ${money(r.paymentAmt)}`} · {r.ratePct}%
                          {r.approvedPct != null && r.approvedPct !== 100 ? ` · 老闆批 ${r.approvedPct}%` : ""}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={`tabular-nums font-medium ${r.commissionAmt < 0 ? "text-danger-text" : ""}`}>{money(r.status === "COUNTED" ? r.countedAmt : r.commissionAmt)}</div>
                        <div className="text-[10px] text-t3">{STATUS[r.status] ?? r.status}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-2xl bg-panel border border-line">
              <div className="px-4 py-2.5 text-[11px] font-semibold text-t2 border-b border-line">我開嘅單</div>
              {data.invoices.length === 0 ? (
                <div className="px-4 py-5 text-sm text-t3 text-center">未有單 — 喺對話右欄「銷售」撳「開單」</div>
              ) : (
                <ul className="divide-y divide-line">
                  {data.invoices.map((i) => (
                    <li key={i.invoiceId} className="px-4 py-2.5 flex items-center gap-3 text-sm" data-e2e="sales-mine-invoice">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Patient code={i.patientCode} name={i.patientName} conv={i.conversationId} />
                          <span className="shrink-0 text-[11px] text-t3">· {i.billCode ?? "—"}</span>
                          {i.isVoid && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-panel-2 text-t2">已作廢</span>}
                        </div>
                        <div className="text-[11px] text-t3">
                          {md(i.createdAt)} 開 · 已收 {money(i.paidAmt)} / {money(i.totalAmt)}
                          {!i.isVoid && (i.osAmt ?? 0) > 0 ? ` · 未收 ${money(i.osAmt!)}（前台之後收都計）` : ""}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="tabular-nums font-medium">{money(i.commission)}</div>
                        <div className="text-[10px] text-t3">{i.held > 0 ? `${money(i.held)} 等批` : "累計傭金"}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="rounded-2xl bg-panel border border-line" data-e2e="sales-mine-pool">
              <div className="px-4 py-2.5 text-[11px] font-semibold text-t2 border-b border-line">銷售公海（最近 60 日放返出嚟 — 邊個約到就係邊個）</div>
              {(data.pool?.length ?? 0) === 0 ? (
                <div className="px-4 py-4 text-[12px] text-t3" data-e2e="sales-mine-pool-empty">
                  而家冇病人喺銷售公海 — 保護期過咗、冇約到嘅病人會喺度出現，邊個約到就係邊個。
                </div>
              ) : (
                <ul className="divide-y divide-line max-h-64 overflow-y-auto">
                  {data.pool!.map((p) => (
                    <li key={p.patientApricotId} className="px-4 py-2 flex items-center gap-3 text-sm" data-e2e="sales-mine-pool-row">
                      <div className="min-w-0 flex-1">
                        <Patient code={p.patientCode} name={p.patientName} conv={p.conversationId} />
                      </div>
                      <span className="shrink-0 text-[11px] text-t3">
                        {md(p.since)} 放出{p.wasMine ? " · 之前係你" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className="text-[11px] text-t3">傭金跟每筆付款計（每晚同步，前台收都計）；付款被作廢會扣返。月結之後先入糧單。</p>
          </>
        )}
      </div>
    </div>
  );
}
