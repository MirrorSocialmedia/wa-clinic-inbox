"use client";

/**
 * 今日可約迷你表（cwi-schedv2-20260903 D.4 — 取代舊「當值卡」）
 *
 * 側欄（detail-pane）：數據 = GET /api/flows/slots?granularity=day&date=today；
 *   - 只 render 由而家起嘅 ONLINE 時段；≤10 行（≈5 小時）
 *   - 欄 = 醫生（62px；>3 人橫向 scroll）；按 onlineSeats 降冪
 *   - 格 = 席位點 ■/□（tooltip = `10:30 · 劉浩賢 · 剩 2 席`）
 *   - 撳格 = 幫佢約：跳過揀病人（內建對話內 = 直接發 Flow prefill 去本對話）；
 *     過窗 → 三出路（D.3；422 競態亦 fallback 三出路）
 *   - 當值人員降底行（不再是卡主體）；「睇成日 →」= /schedule 日視圖
 *   - 15 分鐘 refetch + 換對話 refetch
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import type { FlowSlotsResult } from "@/lib/flow-slots";
import type { ConversationItem } from "./types";
import { WindowExits } from "./window-exits";
import { hhmmToMin, hkNowMin } from "./time";

const REFRESH_MS = 15 * 60 * 1000;
const MAX_ROWS = 10;

function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function hkTodayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
}

function addDaysHk(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface Props {
  conversation: ConversationItem;
  myStaffId: string;
  /** 本對話嘅 clinic code（inbox-client 經 clinics 清單解析；null → 載入失敗態） */
  clinicCode: string | null;
  /** Flow 發送成功後（parent 重拉對話列表/側欄） */
  onFlowSent?: () => void;
}

export function MiniSchedule({ conversation: conv, myStaffId, clinicCode, onFlowSent }: Props) {
  const today = hkTodayStr();
  const [data, setData] = useState<FlowSlotsResult | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [nowMin, setNowMin] = useState<number>(() => hkNowMin());
  const [pick, setPick] = useState<{ providerId: string; start: string; end: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sentFlash, setSentFlash] = useState<string | null>(null);
  const [exits, setExits] = useState(false); // 過窗（client state 或 422 競態）→ 三出路
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!clinicCode) {
      setLoadErr(true);
      return;
    }
    const s = ++seq.current;
    try {
      const res = await fetch(
        `/api/flows/slots?clinicCode=${encodeURIComponent(clinicCode)}&granularity=day&from=${today}&to=${today}`
      );
      if (s !== seq.current) return;
      const j = (res.ok ? (await res.json()) : null) as FlowSlotsResult | null;
      if (j) {
        setData(j);
        setLoadErr(false);
      } else {
        setLoadErr(true);
      }
    } catch {
      if (s === seq.current) setLoadErr(true);
    }
  }, [clinicCode, today]);

  // mount / 換對話 / 換店 → refetch
  useEffect(() => {
    void load();
  }, [load, conv.id]);

  // 15 分鐘 refetch
  useEffect(() => {
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  // 而家分鐘（60s tick — 「由而家起」filter 用）
  useEffect(() => {
    setNowMin(hkNowMin());
    const t = setInterval(() => setNowMin(hkNowMin()), 60_000);
    return () => clearInterval(t);
  }, []);

  const day = data?.days?.[0] ?? null;

  const grid = useMemo(() => {
    if (!day || day.closed) return null;
    const providers = [...(day.providers ?? [])].sort((a, b) => b.onlineSeats - a.onlineSeats);
    const starts = new Set<number>();
    for (const p of providers) {
      for (const s of p.slots ?? []) {
        if (s.state !== "ONLINE") continue;
        const m = hhmmToMin(s.start);
        if (m !== null && m >= nowMin) starts.add(m);
      }
    }
    const rows = [...starts].sort((a, b) => a - b).slice(0, MAX_ROWS);
    return { providers, rows };
  }, [day, nowMin]);

  const cellAt = useCallback(
    (providerId: string, m: number) => {
      if (!grid) return null;
      const p = grid.providers.find((x) => x.providerId === providerId);
      if (!p) return null;
      const s = p.slots?.find((x) => x.start === minToHHmm(m));
      return s && s.state === "ONLINE" ? { slot: s, provider: p } : null;
    },
    [grid]
  );

  const patientName = conv.contact?.profileName || conv.contact?.waId || "病人";
  const winOpen = !!conv.window?.open;
  const dayHref = `/schedule?view=day&date=${today}&clinic=${encodeURIComponent(clinicCode || "")}`;
  const tomorrowHref = `/schedule?view=day&date=${addDaysHk(today, 1)}&clinic=${encodeURIComponent(clinicCode || "")}`;

  async function sendFlow() {
    if (!pick || sending) return;
    setSending(true);
    setSendErr(null);
    try {
      const res = await fetch(`/api/conversations/${conv.id}/flows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prefill: { date: today, providerId: pick.providerId, start: pick.start },
        }),
      });
      const j = (await res.json().catch(() => null)) as { reused?: boolean; error?: string } | null;
      if (res.ok) {
        setPick(null);
        setExits(false);
        setSentFlash(j?.reused ? "呢格 Flow 已經出過（冪等複用）" : "已發預約連結（Flow · 已鎖定呢格）");
        onFlowSent?.();
      } else if (res.status === 422) {
        setPick(null);
        setExits(true);
      } else if (res.status === 423) {
        setSendErr("此對話已有負責人 — 發唔到 Flow（可喺 inbox 撳接手）");
      } else {
        setSendErr(j?.error ?? `發送失敗（${res.status}）`);
      }
    } catch {
      setSendErr("發送失敗（網絡錯誤）");
    }
    setSending(false);
  }

  // ── 空態 / 載入態 ─────────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <CalendarDays size={13} className="text-brand-text" />
        <span className="text-xs font-semibold text-t1">
          今日可約{grid && grid.rows.length > 0 ? ` · ${minToHHmm(grid.rows[0])} 起` : ""}
        </span>
        <a href={dayHref} className="ml-auto text-[10.5px] text-brand-text hover:underline">
          睇成日 →
        </a>
      </div>

      {loadErr && (
        <div className="text-[10.5px] text-t3 rounded-lg border border-line bg-panel-2 p-2">
          今日時段載入失敗（15 分鐘後自動重試）
        </div>
      )}
      {!loadErr && data && !data.connected && (
        <div className="text-[10.5px] text-danger-text rounded-lg border border-warn bg-danger-soft p-2">
          clinic-workforce 未接通 — 讀唔到今天時段
        </div>
      )}
      {!loadErr && data && data.connected && day?.closed && (
        <div className="text-[10.5px] text-t3 rounded-lg border border-line bg-panel-2 p-2">今日休診（冇醫生當值）</div>
      )}
      {!loadErr && grid && grid.rows.length === 0 && (
        <div className="text-[10.5px] text-t3 rounded-lg border border-line bg-panel-2 p-2">
          今日冇可約時段 ·{" "}
          <a href={tomorrowHref} className="text-brand-text hover:underline">
            睇聽日 →
          </a>
        </div>
      )}
      {!loadErr && !data && (
        <div className="text-[10.5px] text-t3 rounded-lg border border-line bg-panel-2 p-2">載入中…</div>
      )}

      {grid && grid.rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <div className="inline-block min-w-full">
            <div
              className="grid"
              style={{ gridTemplateColumns: `48px repeat(${grid.providers.length}, 62px)` }}
            >
              <div />
              {grid.providers.map((p) => (
                <div
                  key={p.providerId}
                  className="px-0.5 py-1 text-center text-[9.5px] font-medium text-t2 truncate"
                  title={p.providerName}
                >
                  {p.providerName}
                </div>
              ))}
              {grid.rows.map((m) => (
                <Fragment key={m}>
                  <div className="px-1 flex items-center justify-end text-[9.5px] font-mono text-t3">
                    {minToHHmm(m)}
                  </div>
                  {grid.providers.map((p) => {
                    const c = cellAt(p.providerId, m);
                    return (
                      <div key={p.providerId} className="p-px">
                        {c ? (
                          <button
                            type="button"
                            onClick={() => {
                              setPick({ providerId: p.providerId, start: c.slot.start, end: c.slot.end });
                              setSendErr(null);
                              setSentFlash(null);
                            }}
                            aria-label={`${c.slot.start} · ${p.providerName} · 剩 ${c.slot.seats} 席`}
                            title={`${c.slot.start} · ${p.providerName} · 剩 ${c.slot.seats} 席`}
                            className={`h-[22px] w-full rounded-[5px] border font-mono tracking-tighter text-[10px] cursor-pointer hover:brightness-95 ${
                              winOpen
                                ? "bg-ok-soft border-ok/50 text-ok-text"
                                : "bg-panel-2 border-line text-t3"
                            }`}
                          >
                            {(() => {
                              const cap = c.provider.capacity ?? c.slot.seats;
                              const left = Math.max(0, Math.min(c.slot.seats, cap));
                              const taken = Math.max(0, cap - c.slot.seats);
                              return (
                                <>
                                  {"■".repeat(left)}
                                  {"□".repeat(taken)}
                                </>
                              );
                            })()}
                          </button>
                        ) : (
                          <div className="h-[22px] rounded-[5px] border border-line bg-panel-2/60" />
                        )}
                      </div>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* D.3：撳格確認帶（內建對話 = 直接發，唔使揀病人） */}
      {pick && (
        <div className="rounded-lg border border-brand bg-brand-soft p-2 space-y-1.5">
          <div className="text-[11px] font-medium text-t1">
            幫 {patientName} 約 {pick.start}–{pick.end}？
          </div>
          {winOpen ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void sendFlow()}
                disabled={sending}
                className="text-xs px-2.5 py-1 rounded-lg bg-brand text-panel font-medium disabled:opacity-40"
              >
                {sending ? "發送中…" : "發送 Flow"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPick(null);
                  setSendErr(null);
                }}
                className="text-xs px-2.5 py-1 rounded-lg border border-line text-t2 hover:bg-panel-2"
              >
                取消
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="text-[10.5px] text-t3">呢位病人 24 小時窗口已過 — Flow 出唔到，改出三出路：</div>
              <WindowExits conversation={conv} myStaffId={myStaffId} />
            </div>
          )}
        </div>
      )}
      {sendErr && <div className="text-[10.5px] text-danger-text">{sendErr}</div>}
      {sentFlash && <div className="text-[10.5px] text-ok-text">{sentFlash}</div>}

      {/* 422 競態 fallback：三出路 */}
      {exits && (
        <div className="space-y-1.5">
          <div className="text-[10.5px] text-t3">24 小時窗口已過 — Flow 出唔到，改出三出路：</div>
          <WindowExits conversation={conv} myStaffId={myStaffId} />
        </div>
      )}

      {/* 當值降底行 + 提示（D.4） */}
      {day && !day.closed && day.duty.length > 0 && (
        <div className="text-[10px] text-t3">當值：{day.duty.map((d) => d.staffName).join("、")}</div>
      )}
      {grid && grid.rows.length > 0 && (
        <div className="text-[10px] text-t3">撳格 = 幫佢約（發去呢位病人對話）</div>
      )}
    </div>
  );
}
