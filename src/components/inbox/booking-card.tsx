"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CalendarDays, Check, Lock, RotateCcw } from "lucide-react";
import type { BookingInfo, ConversationItem } from "./types";

/**
 * 預約請求卡 — 兩態（booking-ui D，MD §3 照 mockup）
 *
 * PENDING（綠邊）：病人 + 醫生/日期/時間 + 主訴 + 空檔初驗 + visitReason 下拉
 *   + 三掣：〔幫我喺 Apricot 落單〕（藍，已釘住先出現）/〔已人手落單〕/〔改期 · 重發 Flow〕
 *   409 → 紅字「時段啱啱滿咗」+ 〔重發 Flow〕；422/503 → 人手指示
 *
 * CONFIRMED：Apricot 單號 + 發起人 + 「確認訊息已自動發出」+ 〔撤銷（mm:ss）〕
 *   5 分鐘內可撤銷（removeBooking → 卡彈返 PENDING；server 強制窗口）；過 5 分鐘掣消失。
 *
 * 即時刷新：每個寫動作後 onActionDone()（parent REST 重拉）+ socket booking:updated/changed 雙保險。
 * 本組件零 PII 直接攬 — 只用 conversation/booking 嘅已授權欄位（姓名 = 白名單 v2）。
 */

interface DictItem {
  apricotId: string;
  code: string;
  des: string;
}

interface Props {
  conversation: ConversationItem;
  booking: BookingInfo;
  myStaffId: string;
  /** 寫動作完成（create/confirm/reschedule/rollback）→ parent 重拉對話 + 側欄 */
  onActionDone: () => void;
}

const ROLLBACK_WINDOW_MS = 5 * 60 * 1000;
const TOD_LABEL: Record<string, string> = { MORNING: "上晝", AFTERNOON: "下晝", EVENING: "夜晚" };

/** pure：mm:ss 倒數格式化（unit test 用） */
export function formatMmSs(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.ceil(clamped / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** pure：5 分鐘撤銷窗口邊界（unit test 用）：true = 掣應該喺度 */
export function rollbackButtonVisible(handledAt: string | null | undefined, now: number): boolean {
  if (!handledAt) return false;
  const t = Date.parse(handledAt);
  if (Number.isNaN(t)) return false;
  const elapsed = now - t;
  return elapsed >= 0 && elapsed <= ROLLBACK_WINDOW_MS;
}

/** pure："YYYY-MM-DD" → 收據卡頭大字（9月1日）+ 星期（zh-Hant short） */
export function fmtRequestDay(dateStr: string): { main: string; weekday: string } {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { main: dateStr, weekday: "" };
  const main = `${d.getMonth() + 1}月${d.getDate()}日`;
  const weekday = d.toLocaleDateString("zh-Hant-HK", { weekday: "short" });
  return { main, weekday };
}

export function BookingCard({ conversation: c, booking: b, myStaffId, onActionDone }: Props) {
  const pinned = !!c.pinnedPatient?.patientApricotId;
  const locked = !!c.assigneeId && c.assigneeId !== myStaffId;

  // ── visitReason 下拉（dictionaries + default env）──────────────────
  const [dictItems, setDictItems] = useState<DictItem[] | null>(null);
  const [defaultCode, setDefaultCode] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dictError, setDictError] = useState<string | null>(null);

  // ── 掣狀態 ──────────────────────────────────────────────────────
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{ kind: "slot_taken" | "manual" | "generic"; message: string } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackMsg, setRollbackMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  // ── 1 秒 tick（CONFIRMED 倒數）──────────────────────────────────
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (b.status !== "CONFIRMED") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [b.status, b.id]);

  // 換 booking → 重置所有本地狀態
  useEffect(() => {
    setDictItems(null);
    setDefaultCode(null);
    setSelectedId(null);
    setDictError(null);
    setCreating(false);
    setCreateError(null);
    setConfirmMsg(null);
    setResendMsg(null);
    setRollbackMsg(null);
  }, [b.id, b.status]);

  // 攞 dictionaries（PENDING 先要）
  useEffect(() => {
    if (b.status !== "PENDING" || dictItems !== null) return;
    let cancelled = false;
    fetch("/api/dictionaries?kind=VISIT_REASON")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { items: DictItem[]; defaultCode: string | null };
      })
      .then((data) => {
        if (cancelled) return;
        setDictItems(data.items);
        setDefaultCode(data.defaultCode);
        const def = data.items.find((i) => i.code === data.defaultCode);
        setSelectedId(def ? def.apricotId : null);
      })
      .catch((e) => {
        if (!cancelled) setDictError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [b.status, b.id, dictItems]);

  const slotText = b.requestedTime ?? TOD_LABEL[b.timeOfDay ?? ""] ?? "時段待定";
  const rollbackVisible = b.status === "CONFIRMED" && rollbackButtonVisible(b.handledAt, now);

  // ── 寫動作 handlers ─────────────────────────────────────────────
  async function doCreate() {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch(`/api/bookings/${b.id}/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedId ? { visitReasonId: selectedId } : {}),
      });
      const j = (await res.json().catch(() => null)) as {
        error?: string;
        message?: string;
        manual?: boolean;
        autoMessage?: { sent: boolean; hint?: string; reason?: string };
      } | null;
      if (res.ok || res.status === 422) {
        // 422 = 已落單但確認訊息要 template（window closed）— 卡會經 onActionDone 轉 CONFIRMED
        if (j?.autoMessage && !j.autoMessage.sent) {
          setConfirmMsg({ tone: "warn", text: j.autoMessage.hint ?? "確認訊息未自動發 — 請手覆" });
        }
        onActionDone();
        return;
      }
      if (res.status === 409) {
        setCreateError({ kind: "slot_taken", message: j?.message ?? "時段啱啱滿咗" });
        return;
      }
      if (res.status === 400 && j?.error === "visit_reason_required") {
        setCreateError({ kind: "generic", message: j.message ?? "請先揀 visit reason" });
        return;
      }
      if (res.status === 400 && j?.error === "no_pinned_patient") {
        setCreateError({ kind: "generic", message: j.message ?? "要先喺右側欄釘住舊客" });
        return;
      }
      if (j?.manual || res.status >= 500) {
        setCreateError({ kind: "manual", message: j?.message ?? "代落單失敗 — 請人手喺 Apricot 落單" });
        return;
      }
      setCreateError({ kind: "generic", message: j?.message ?? `HTTP ${res.status}` });
    } catch (e) {
      setCreateError({ kind: "generic", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  }

  async function doConfirm() {
    if (confirmBusy) return;
    setConfirmBusy(true);
    setConfirmMsg(null);
    try {
      const res = await fetch(`/api/bookings/${b.id}/confirm`, { method: "POST" });
      const j = (await res.json().catch(() => null)) as {
        autoMessage?: { sent: boolean; hint?: string };
        error?: string;
      } | null;
      if (res.ok || res.status === 422) {
        if (j?.autoMessage?.sent) setConfirmMsg({ tone: "ok", text: "已確認 + 確認訊息已發俾病人 ✅" });
        else setConfirmMsg({ tone: "warn", text: j?.autoMessage?.hint ?? "已確認（訊息未自動發 — 見提示）" });
        onActionDone();
        return;
      }
      if (res.status === 409) {
        setConfirmMsg({ tone: "warn", text: "呢張卡已經處理過（狀態已變）" });
        onActionDone();
        return;
      }
      setConfirmMsg({ tone: "warn", text: j?.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setConfirmMsg({ tone: "warn", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setConfirmBusy(false);
    }
  }

  async function doResendFlow() {
    if (resendBusy) return;
    setResendBusy(true);
    setResendMsg(null);
    try {
      const res = await fetch(`/api/bookings/${b.id}/reschedule`, { method: "POST" });
      const j = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (res.ok) {
        setResendMsg({ tone: "ok", text: "預約 Flow 已重發俾病人（等佢揾新時段）" });
        onActionDone();
        return;
      }
      setResendMsg({ tone: "warn", text: j?.message ?? j?.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setResendMsg({ tone: "warn", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setResendBusy(false);
    }
  }

  async function doRollback() {
    if (rollbackBusy) return;
    setRollbackBusy(true);
    setRollbackMsg(null);
    try {
      const res = await fetch(`/api/bookings/${b.id}/rollback`, { method: "POST" });
      const j = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (res.ok) {
        setRollbackMsg({ tone: "ok", text: "已撤銷（Apricot 單已刪）— 卡彈返 PENDING；唔會自動覆病人" });
        onActionDone();
        return;
      }
      if (res.status === 423) {
        setRollbackMsg({ tone: "warn", text: j?.message ?? "只有負責人可以撤銷" });
        return;
      }
      if (res.status === 410) {
        setRollbackMsg({ tone: "warn", text: j?.message ?? "超過 5 分鐘撤銷窗口" });
        onActionDone();
        return;
      }
      setRollbackMsg({ tone: "warn", text: j?.message ?? `撤銷失敗（HTTP ${res.status}）— 請人手喺 Apricot 取消` });
    } catch (e) {
      setRollbackMsg({ tone: "warn", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRollbackBusy(false);
    }
  }

  // ── PENDING 態（Organic 1e 收據式：預設鼠尾草；slot_taken = 整卡陶土）────────────
  if (b.status === "PENDING") {
    const slotTaken = createError?.kind === "slot_taken";
    const day = fmtRequestDay(b.requestedDate);
    return (
      <div
        className={`mb-2 rounded-[26px] overflow-hidden ${
          slotTaken
            ? "bg-danger-soft border-[1.5px] border-warn"
            : "bg-ok-soft border-[1.5px] border-brand"
        }`}
      >
        {/* 卡頭 */}
        <div className={`px-4 pt-3 pb-3 text-panel ${slotTaken ? "bg-danger" : "bg-ok"}`}>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.1em] uppercase opacity-90">
              {slotTaken ? (
                <AlertTriangle size={12} strokeWidth={2.75} />
              ) : (
                <CalendarDays size={12} strokeWidth={2.75} />
              )}
              {slotTaken ? "撞單 · 位已滿" : "新預約請求"}
            </span>
            <a href="/bookings" className="ml-auto text-[11px] opacity-90 hover:opacity-100 whitespace-nowrap">
              去 /bookings 處理 →
            </a>
          </div>
          <div className="font-display text-[25px] leading-[1.15] mt-1.5">
            {day.main} {slotText}
          </div>
          <div className="text-xs opacity-90 mt-0.5">
            {day.weekday}
            {day.weekday ? " · " : ""}
            {b.providerName}
          </div>
        </div>

        {/* 卡身 */}
        <div className="px-4 py-3 flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="text-t2 shrink-0">病人</span>
            <span className="font-semibold text-t1 text-right">{c.contact?.profileName ?? "—"}</span>
          </div>
          {b.chiefComplaint && (
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-t2 shrink-0">主訴</span>
              <span className="text-t1 text-right">{b.chiefComplaint}</span>
            </div>
          )}
          {/* 空檔初驗 */}
          <div className="border-t border-line pt-2">
            {b.precheckPassed === true && <span className="text-[10.5px] text-ok-text">✓ 空檔初驗過</span>}
            {b.precheckPassed === null && <span className="text-[10.5px] text-t3">空檔未核對（資料源離線）</span>}
            {b.precheckPassed === false && <span className="text-[10.5px] text-danger-text">✗ 空檔初驗未過</span>}
          </div>

          {slotTaken ? (
            <>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-danger-text font-medium inline-flex items-center gap-1">
                  <AlertTriangle size={12} strokeWidth={2.75} /> {createError?.message ?? "時段啱啱滿咗"}
                </span>
                <button
                  onClick={() => void doResendFlow()}
                  disabled={resendBusy}
                  className="inline-flex items-center gap-1 rounded-full border border-danger-text text-danger-text px-2.5 py-1 hover:bg-danger-soft disabled:opacity-40"
                >
                  <RotateCcw size={11} strokeWidth={2.75} /> {resendBusy ? "發送中…" : "重發 Flow"}
                </button>
              </div>
              <p className="text-[10.5px] leading-relaxed text-danger-text">
                目標時段已唔再可落單 — 可重發 Flow 俾病人重新揾時間，或者直接開對話跟進。
              </p>
            </>
          ) : (
            <>
              {/* visitReason 下拉 + 三掣（Organic：全部 rounded-full，主掣 brand-hover） */}
              <select
                value={selectedId ?? ""}
                onChange={(e) => setSelectedId(e.target.value || null)}
                disabled={creating || dictError !== null}
                className="w-full text-xs px-3 py-2 rounded-full border border-line-strong bg-panel text-t1"
                title="Visit reason（寫入 Apricot remarks + payload）"
              >
                {dictError ? (
                  <option value="">dictionaries 載入失敗（{dictError}）</option>
                ) : dictItems === null ? (
                  <option value="">載入 visit reason…</option>
                ) : (
                  <>
                    {selectedId === null && <option value="">— 揀 visit reason —</option>}
                    {dictItems.map((i) => (
                      <option key={i.apricotId} value={i.apricotId}>
                        {i.code} {i.des}
                        {i.code === defaultCode ? "（預設）" : ""}
                      </option>
                    ))}
                  </>
                )}
              </select>
              {pinned ? (
                <button
                  onClick={() => void doCreate()}
                  disabled={creating || selectedId === null}
                  title={selectedId === null ? "先揀 visit reason" : undefined}
                  className="w-full rounded-full bg-brand-hover text-panel text-[13px] font-semibold px-3.5 py-2.5 hover:opacity-90 disabled:opacity-40"
                >
                  {creating ? "代落單中…" : "幫我喺 Apricot 落單"}
                </button>
              ) : (
                <span className="text-[10.5px] text-t3 inline-flex items-center gap-1">
                  <Lock size={10} strokeWidth={2.75} /> 未釘住舊客 — 先喺右側欄釘住先可以代落單
                </span>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => void doConfirm()}
                  disabled={confirmBusy || creating}
                  className="flex-1 rounded-full border border-line bg-panel text-t1 text-xs px-3 py-2 hover:bg-panel-2 disabled:opacity-40"
                >
                  {confirmBusy ? "處理中…" : "已人手落單"}
                </button>
                <button
                  onClick={() => void doResendFlow()}
                  disabled={resendBusy || creating}
                  className="flex-1 rounded-full border border-line bg-panel text-t1 text-xs px-3 py-2 hover:bg-panel-2 disabled:opacity-40"
                >
                  {resendBusy ? "發送中…" : "改期 · 重發 Flow"}
                </button>
              </div>
            </>
          )}

          {/* 422/503 人手指示 / 其他提示（slot_taken 已在上面整卡陶土處理） */}
          {createError && createError.kind !== "slot_taken" && (
            <div
              className={`text-xs inline-flex items-center gap-1 ${
                createError.kind === "manual" ? "text-warn-text" : "text-danger-text"
              }`}
            >
              <AlertTriangle size={12} strokeWidth={2.75} /> {createError.message}
            </div>
          )}
          {confirmMsg && (
            <div className={`text-xs ${confirmMsg.tone === "ok" ? "text-ok-text" : "text-warn-text"}`}>{confirmMsg.text}</div>
          )}
          {resendMsg && (
            <div className={`text-xs ${resendMsg.tone === "ok" ? "text-ok-text" : "text-warn-text"}`}>{resendMsg.text}</div>
          )}
        </div>
      </div>
    );
  }

  // ── CONFIRMED 態（卡頭 brand-hover，大字 Caprasimo；撤銷窗口邏輯照舊）────────────
  if (b.status === "CONFIRMED") {
    const countdown = b.handledAt ? Math.max(0, Date.parse(b.handledAt) + ROLLBACK_WINDOW_MS - now) : 0;
    const day = fmtRequestDay(b.requestedDate);
    return (
      <div className="mb-2 rounded-[26px] overflow-hidden bg-panel border-[1.5px] border-brand">
        {/* 卡頭 */}
        <div className="px-4 pt-3 pb-3 bg-brand-hover text-panel">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.1em] uppercase opacity-90">
              <Check size={12} strokeWidth={3} /> 已確認 · Apricot
            </span>
            <a href="/bookings" className="ml-auto text-[11px] opacity-90 hover:opacity-100 whitespace-nowrap">
              去 /bookings 處理 →
            </a>
          </div>
          <div className="font-display text-[25px] leading-[1.15] mt-1.5">
            {day.main} {slotText}
          </div>
          <div className="text-xs opacity-90 mt-0.5">確認訊息已自動發給病人</div>
        </div>

        {/* 卡身 */}
        <div className="px-4 py-3 flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="text-t2">病人</span>
            <span className="font-semibold text-t1 text-right">{c.contact?.profileName ?? "—"}</span>
          </div>
          {b.apricotApptId && (
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-t2">Apricot 單號</span>
              <span className="font-mono text-[11.5px] text-t1">{b.apricotApptId}</span>
            </div>
          )}
          {b.handledByStaffName && (
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-t2">發起人</span>
              <span className="text-t1">{b.handledByStaffName}</span>
            </div>
          )}
          {b.visitReasonCode && (
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-t2">Visit reason</span>
              <span className="text-t1">{b.visitReasonCode}</span>
            </div>
          )}
          {rollbackVisible && (
            <div className="border-t border-line pt-2.5">
              <button
                onClick={() => void doRollback()}
                disabled={rollbackBusy || locked}
                title={locked ? "Send Lock：只有負責人才可以撤銷" : "撤銷代落單（Apricot 單會刪除，卡彈返 PENDING；唔會自動覆病人）"}
                className="w-full rounded-full border border-warn bg-panel text-danger-text text-xs font-semibold px-3 py-2 hover:bg-danger-soft disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
              >
                <RotateCcw size={12} strokeWidth={2.75} />
                {rollbackBusy ? "撤銷中…" : `撤銷（${formatMmSs(countdown)}）`}
              </button>
              {locked && (
                <span className="mt-1.5 block text-[10.5px] text-warn-text inline-flex items-center gap-1">
                  <Lock size={10} strokeWidth={2.75} /> 只限負責人撤銷（{c.assigneeName}）
                </span>
              )}
            </div>
          )}
          <p className="text-[10.5px] leading-relaxed text-t2">
            5 分鐘內可撤銷 — Apricot 單會刪除，卡彈回待處理，唔會再覆病人。過窗要用側欄預約卡改期或取消。
          </p>
          {confirmMsg && (
            <div className={`text-xs ${confirmMsg.tone === "ok" ? "text-ok-text" : "text-warn-text"}`}>{confirmMsg.text}</div>
          )}
          {rollbackMsg && (
            <div className={`text-xs ${rollbackMsg.tone === "ok" ? "text-ok-text" : "text-warn-text"}`}>{rollbackMsg.text}</div>
          )}
        </div>
      </div>
    );
  }

  // REJECTED / EXPIRED（簡短顯示 — 隊列頁先處理；Organic：灰調 + 收圓角）
  const day2 = fmtRequestDay(b.requestedDate);
  return (
    <div className="mb-2 rounded-[26px] border border-line bg-panel-2 p-3.5 opacity-75">
      <div className="flex items-center gap-2">
        <span className="text-xs text-t3 inline-flex items-center gap-1">
          <CalendarDays size={13} strokeWidth={2.75} /> 預約請求（{b.status === "EXPIRED" ? "已過期" : "已拒絕"}）
        </span>
      </div>
      <div className="mt-1 text-[13px] text-t2 line-through">
        {day2.main} {slotText} · {b.providerName}
      </div>
    </div>
  );
}
