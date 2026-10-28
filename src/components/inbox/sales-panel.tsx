"use client";

/**
 * ★ cwi-sales-20261028：銷售系統第 1 期 UI。
 *
 * - useSalesView：GET /api/conversations/:id/sales（換對話／新病人訊息／動作後 window 事件重拉）
 * - SalesCard（右欄）：歸屬（保護中／綁定 · 銷售 · 到期）、意向 高中低、轉交／收回、請求轉交、強制接手
 * - SalesLockBanner（對話頂）：唔係負責人 → 「{名} 負責（銷售）· 可以睇，唔可以覆」+ 請求轉交／強制接手
 *
 * 只喺「我係銷售人員」或者「呢個對話有銷售負責」先顯示 — 其他情況完全唔出（唔干擾冇用銷售系統嘅店）。
 */
import { useCallback, useEffect, useState } from "react";
import { Lock, ShieldCheck, UserCheck } from "lucide-react";

export const SALES_CHANGED_EVENT = "wa:sales-changed";

export type SalesIntentLevel = "HIGH" | "MEDIUM" | "LOW";

export interface SalesView {
  viewerIsSales: boolean;
  owners: { staffId: string; name: string; state: "PROTECTED" | "BOUND"; protectedUntil: string | null }[];
  delegates: { id: string; staffId: string; name: string; kind: string; expiresAt: string | null }[];
  canReply: boolean;
  isOwner: boolean;
  canForce: boolean;
  intent: { level: SalesIntentLevel; byName: string | null; at: string } | null;
  intentLabels: string[];
}

const LEVELS: SalesIntentLevel[] = ["HIGH", "MEDIUM", "LOW"];

const md = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const mdhm = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

export function notifySalesChanged(conversationId: string): void {
  window.dispatchEvent(new CustomEvent(SALES_CHANGED_EVENT, { detail: { conversationId } }));
}

export function useSalesView(conversationId: string | null, refreshKey?: string | number | null) {
  const [view, setView] = useState<SalesView | null>(null);
  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/conversations/${conversationId}/sales`, { cache: "no-store" });
      if (!res.ok) return;
      setView(((await res.json()) as { sales: SalesView }).sales);
    } catch {
      /* 網絡錯 — 保留上次 */
    }
  }, [conversationId]);
  useEffect(() => {
    setView(null);
  }, [conversationId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (!id || id === conversationId) void load();
    };
    window.addEventListener(SALES_CHANGED_EVENT, on);
    return () => window.removeEventListener(SALES_CHANGED_EVENT, on);
  }, [conversationId, load]);
  return { view, setView, reload: load };
}

async function post(conversationId: string, body: Record<string, unknown>): Promise<{ ok: boolean; view?: SalesView; error?: string }> {
  try {
    const res = await fetch(`/api/conversations/${conversationId}/sales/handover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { sales?: SalesView; message?: string } | null;
    if (!res.ok) return { ok: false, error: data?.message ?? "做唔到，請再試" };
    notifySalesChanged(conversationId);
    return { ok: true, view: data?.sales };
  } catch {
    return { ok: false, error: "網絡錯誤" };
  }
}

function ownerLine(v: SalesView): string {
  return v.owners.map((o) => `${o.name}${o.state === "PROTECTED" && o.protectedUntil ? ` · 至 ${md(o.protectedUntil)}` : ""}`).join("／");
}

export function SalesCard({
  conversationId,
  staffOptions,
  userRole,
  refreshKey,
}: {
  conversationId: string;
  staffOptions: { id: string; name: string; role?: string }[];
  userRole: "ADMIN" | "STAFF" | "SUPERVISOR";
  refreshKey?: string | number | null;
}) {
  const { view, setView } = useSalesView(conversationId, refreshKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [toStaffId, setToStaffId] = useState("");
  const [kind, setKind] = useState<"ONCE" | "PERMANENT">("ONCE");

  useEffect(() => {
    setHandoverOpen(false);
    setErr(null);
    setToStaffId("");
  }, [conversationId]);

  if (!view || (!view.viewerIsSales && view.owners.length === 0)) return null;
  const locked = view.owners.length > 0;
  const ownerIds = new Set(view.owners.map((o) => o.staffId));
  const pickable = staffOptions.filter((s) => !ownerIds.has(s.id) && s.role !== "SUPERVISOR");
  const canIntent = view.viewerIsSales && userRole !== "SUPERVISOR" && (!locked || view.canReply);

  async function act(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await post(conversationId, body);
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "做唔到");
    else {
      if (r.view) setView(r.view);
      setHandoverOpen(false);
    }
  }

  async function setIntent(level: SalesIntentLevel | null) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/sales`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: level }),
      });
      const data = (await res.json().catch(() => null)) as { sales?: SalesView; message?: string } | null;
      if (!res.ok) setErr(data?.message ?? "做唔到");
      else if (data?.sales) setView(data.sales);
    } catch {
      setErr("網絡錯誤");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-e2e="sales-card">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2 mb-2">銷售</div>
      <div className="rounded-2xl border border-line bg-panel-2 p-3 flex flex-col gap-2.5">
        {locked ? (
          <div className="flex items-start gap-2 text-xs text-t1">
            {view.owners.some((o) => o.state === "BOUND") ? (
              <ShieldCheck className="w-4 h-4 text-brand-text shrink-0 mt-px" aria-hidden />
            ) : (
              <UserCheck className="w-4 h-4 text-brand-text shrink-0 mt-px" aria-hidden />
            )}
            <div className="min-w-0">
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-soft text-brand-text font-medium mr-1.5">
                {view.owners.some((o) => o.state === "BOUND") ? "綁定" : "保護中"}
              </span>
              <span data-e2e="sales-owner">{ownerLine(view)}</span>
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-t3">未有銷售負責 · 經 inbox 落預約或者發 Flow 就會開始保護期</div>
        )}

        {view.viewerIsSales && (
          <div>
            <div className="text-[10px] text-t3 mb-1">意向</div>
            <div className="flex gap-1.5" role="group" aria-label="意向分級">
              {LEVELS.map((lv, i) => {
                const on = view.intent?.level === lv;
                return (
                  <button
                    key={lv}
                    type="button"
                    data-e2e={`sales-intent-${lv}`}
                    aria-pressed={on}
                    disabled={!canIntent || busy}
                    onClick={() => void setIntent(on ? null : lv)}
                    className={`flex-1 text-xs py-1 rounded-full border disabled:opacity-50 ${
                      on ? "bg-brand text-panel border-brand" : "bg-panel border-line text-t1 hover:bg-panel-2"
                    }`}
                  >
                    {view.intentLabels[i] ?? lv}
                  </button>
                );
              })}
            </div>
            {view.intent && (
              <div className="text-[10px] text-t3 mt-1">
                {view.intent.byName ?? "同事"} · {mdhm(view.intent.at)}
              </div>
            )}
          </div>
        )}

        {view.delegates.length > 0 && (
          <div className="flex flex-col gap-1">
            {view.delegates.map((d) => (
              <div key={d.id} className="flex items-center gap-2 text-[11px] text-t2">
                <span className="min-w-0 truncate">
                  {d.kind === "FORCE" ? "主管接手" : "已轉交"}：{d.name}
                  {d.expiresAt ? `（至 ${mdhm(d.expiresAt)}）` : "（直至收回）"}
                </span>
                {(view.isOwner || userRole === "ADMIN") && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act({ action: "revoke", delegationId: d.id })}
                    className="ml-auto shrink-0 text-[11px] px-2 py-0.5 rounded-full border border-line text-t1 hover:bg-panel disabled:opacity-50"
                  >
                    收回
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {view.isOwner && userRole !== "SUPERVISOR" && (
          handoverOpen ? (
            <div className="flex flex-col gap-1.5">
              <select
                id="sales-handover-to"
                value={toStaffId}
                onChange={(e) => setToStaffId(e.target.value)}
                className="text-xs rounded-full bg-panel border border-line px-3 py-1.5 text-t1"
              >
                <option value="">揀同事…</option>
                {pickable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-1.5">
                {(["ONCE", "PERMANENT"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                    className={`flex-1 text-[11px] py-1 rounded-full border ${kind === k ? "bg-brand-soft text-brand-text border-brand" : "bg-panel border-line text-t2"}`}
                  >
                    {k === "ONCE" ? "今次（24 小時）" : "直至收回"}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={!toStaffId || busy}
                  onClick={() => void act({ action: "delegate", toStaffId, kind })}
                  className="flex-1 text-xs py-1.5 rounded-full bg-brand text-panel font-medium disabled:opacity-50"
                >
                  確認轉交
                </button>
                <button type="button" onClick={() => setHandoverOpen(false)} className="flex-1 text-xs py-1.5 rounded-full bg-panel border border-line text-t2">
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-e2e="sales-handover-open"
              onClick={() => setHandoverOpen(true)}
              className="text-xs py-1.5 rounded-full bg-panel border border-line text-t1 hover:bg-panel-2"
            >
              轉交畀同事
            </button>
          )
        )}

        {locked && !view.canReply && <SalesLockActions conversationId={conversationId} view={view} staffOptions={pickable} userRole={userRole} onDone={setView} compact />}
        {err && <div className="text-[11px] text-danger-text">{err}</div>}
      </div>
    </div>
  );
}

/** 請求轉交 / 強制接手（右欄同對話頂部共用） */
function SalesLockActions({
  conversationId,
  view,
  staffOptions,
  userRole,
  onDone,
  compact,
}: {
  conversationId: string;
  view: SalesView;
  staffOptions: { id: string; name: string; role?: string }[];
  userRole: "ADMIN" | "STAFF" | "SUPERVISOR";
  onDone: (v: SalesView) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [forceOpen, setForceOpen] = useState(false);
  const [forceTo, setForceTo] = useState("");
  const names = [...new Set(view.owners.map((o) => o.name))].join("／");

  async function act(body: Record<string, unknown>, okMsg: string) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const r = await post(conversationId, body);
    setBusy(false);
    if (!r.ok) setMsg(r.error ?? "做唔到");
    else {
      setMsg(okMsg);
      setForceOpen(false);
      if (r.view) onDone(r.view);
    }
  }

  const size = compact ? "text-[11px] py-1" : "text-xs py-1.5";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5 flex-wrap">
        {userRole !== "SUPERVISOR" && (
          <button
            type="button"
            data-e2e="sales-request-handover"
            disabled={busy}
            onClick={() => void act({ action: "request" }, `已通知 ${names}`)}
            className={`flex-1 min-w-[7rem] ${size} px-3 rounded-full bg-panel border border-line text-t1 hover:bg-panel-2 disabled:opacity-50`}
          >
            請 {names} 轉交
          </button>
        )}
        {view.canForce && (
          <button
            type="button"
            data-e2e="sales-force-open"
            disabled={busy}
            onClick={() => (userRole === "ADMIN" ? void act({ action: "force" }, "已接手（24 小時）") : setForceOpen(true))}
            className={`flex-1 min-w-[7rem] ${size} px-3 rounded-full border border-danger-text text-danger-text hover:bg-danger-soft disabled:opacity-50`}
          >
            主管強制接手
          </button>
        )}
      </div>
      {forceOpen && (
        <div className="flex gap-1.5">
          <select
            id="sales-force-to"
            value={forceTo}
            onChange={(e) => setForceTo(e.target.value)}
            className="flex-1 text-xs rounded-full bg-panel border border-line px-3 py-1.5 text-t1"
          >
            <option value="">交畀邊個同事…</option>
            {staffOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!forceTo || busy}
            onClick={() => void act({ action: "force", toStaffId: forceTo }, "已交畀同事（24 小時）")}
            className="text-xs px-3 py-1.5 rounded-full bg-brand text-panel font-medium disabled:opacity-50"
          >
            確認
          </button>
        </div>
      )}
      {msg && <div className="text-[11px] text-t2">{msg}</div>}
    </div>
  );
}

export function SalesLockBanner({
  conversationId,
  staffOptions,
  userRole,
  refreshKey,
  compact,
}: {
  conversationId: string;
  staffOptions: { id: string; name: string; role?: string }[];
  userRole: "ADMIN" | "STAFF" | "SUPERVISOR";
  refreshKey?: string | number | null;
  compact: boolean;
}) {
  const { view, setView } = useSalesView(conversationId, refreshKey);
  if (!view || view.owners.length === 0 || view.canReply) return null;
  const names = [...new Set(view.owners.map((o) => o.name))].join("／");
  const bound = view.owners.some((o) => o.state === "BOUND");
  const ownerIds = new Set(view.owners.map((o) => o.staffId));
  return (
    <div data-e2e="sales-lock-banner" className={`mx-3 mt-2 rounded-2xl border border-line bg-panel-2 ${compact ? "px-3 py-2" : "px-4 py-2.5"} flex flex-col gap-2`}>
      <div className="flex items-center gap-2 text-xs text-t1">
        <Lock className="w-3.5 h-3.5 text-t2 shrink-0" aria-hidden />
        <span className="min-w-0">
          <b>{names} 負責</b>（{bound ? "綁定病人" : "銷售保護中"}）· 你可以睇，唔可以覆
        </span>
      </div>
      {!compact && (
        <SalesLockActions
          conversationId={conversationId}
          view={view}
          staffOptions={staffOptions.filter((s) => !ownerIds.has(s.id) && s.role !== "SUPERVISOR")}
          userRole={userRole}
          onDone={setView}
        />
      )}
    </div>
  );
}
