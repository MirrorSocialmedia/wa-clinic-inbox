"use client";

/**
 * ★ cwi-sales 第 3 期：我的銷售（client）— GET /api/sales/mine?month=
 * 傭金跟每筆付款計（每晚同步）；HELD = 等老闆批（對單／冇打卡申訴）；月結（第 4 期）先入糧單。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { WLoading } from "@/components/ui/w-loader";

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
interface Data {
  month: string;
  counts: { protected: number; bound: number };
  ledger: { closed: boolean; totals: { counted: number; held: number; excluded: number; rejected: number; lines: number }; rows: Row[] };
  invoices: Invoice[];
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

export default function SalesMineClient() {
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
      <div className="max-w-3xl mx-auto px-4 py-5 space-y-4 pb-24">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-t1">我的銷售</h1>
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
            <p className="text-[11px] text-t3">傭金跟每筆付款計（每晚同步，前台收都計）；付款被作廢會扣返。月結之後先入糧單。</p>
          </>
        )}
      </div>
    </div>
  );
}
