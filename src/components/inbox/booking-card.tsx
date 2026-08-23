"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CalendarDays, Lock, RotateCcw } from "lucide-react";
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

  // ── PENDING 態 ─────────────────────────────────────────────────
  if (b.status === "PENDING") {
    return (
      <div className="mb-2 rounded-xl border border-ok/40 bg-ok-soft p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ok-text inline-flex items-center gap-1 shrink-0">
            <CalendarDays size={13} /> 新預約請求
          </span>
          <span className="text-sm text-t1 font-medium truncate">
            {b.providerName} · {b.requestedDate} {slotText}
          </span>
          {/* 空檔初驗 */}
          {b.precheckPassed === true && <span className="text-[10px] text-ok-text shrink-0">✓ 空檔初驗過</span>}
          {b.precheckPassed === null && <span className="text-[10px] text-t3 shrink-0">空檔未核對（資料源離線）</span>}
          {b.precheckPassed === false && <span className="text-[10px] text-danger-text shrink-0">✗ 空檔初驗未過</span>}
          <a href="/bookings" className="ml-auto shrink-0 text-xs px-2.5 py-1 rounded-lg bg-ok text-white font-medium hover:opacity-90">
            去 /bookings 處理 →
          </a>
        </div>

        {/* 病人 + 主訴 */}
        <div className="mt-1.5 text-xs text-t2">
          病人：<span className="text-t1">{c.contact?.profileName ?? "—"}</span>
          {b.chiefComplaint && <span className="text-t3"> ｜ 主訴：{b.chiefComplaint}</span>}
        </div>

        {/* visitReason 下拉 + 三掣 */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value || null)}
            disabled={creating || dictError !== null}
            className="text-xs px-2 py-1.5 rounded-lg border border-line bg-panel text-t1 max-w-[220px]"
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
              className="text-xs px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white font-medium disabled:opacity-40 inline-flex items-center gap-1"
            >
              {creating ? "代落單中…" : "幫我喺 Apricot 落單"}
            </button>
          ) : (
            <span className="text-[10px] text-t3 inline-flex items-center gap-1">
              <Lock size={10} /> 未釘住舊客 — 先喺右側欄釘住先可以代落單
            </span>
          )}
          <button
            onClick={() => void doConfirm()}
            disabled={confirmBusy || creating}
            className="text-xs px-3 py-1.5 rounded-lg border border-line bg-panel text-t1 hover:bg-panel-2 disabled:opacity-40"
          >
            {confirmBusy ? "處理中…" : "已人手落單"}
          </button>
          <button
            onClick={() => void doResendFlow()}
            disabled={resendBusy || creating}
            className="text-xs px-3 py-1.5 rounded-lg border border-line bg-panel text-t1 hover:bg-panel-2 disabled:opacity-40"
          >
            {resendBusy ? "發送中…" : "改期 · 重發 Flow"}
          </button>
        </div>

        {/* 409 紅字 / 422/503 人手指示 / 其他提示 */}
        {createError?.kind === "slot_taken" && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-danger-text font-medium inline-flex items-center gap-1">
              <AlertTriangle size={12} /> {createError.message}
            </span>
            <button
              onClick={() => void doResendFlow()}
              disabled={resendBusy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-danger-text text-danger-text hover:bg-danger-soft disabled:opacity-40"
            >
              <RotateCcw size={11} /> {resendBusy ? "發送中…" : "重發 Flow"}
            </button>
          </div>
        )}
        {createError && createError.kind !== "slot_taken" && (
          <div
            className={`mt-2 text-xs inline-flex items-center gap-1 ${
              createError.kind === "manual" ? "text-warn-text" : "text-danger-text"
            }`}
          >
            <AlertTriangle size={12} /> {createError.message}
          </div>
        )}
        {confirmMsg && (
          <div className={`mt-2 text-xs ${confirmMsg.tone === "ok" ? "text-ok-text" : "text-warn-text"}`}>{confirmMsg.text}</div>
        )}
        {resendMsg && (
          <div className={`mt-2 text-xs ${resendMsg.tone === "ok" ? "text-ok-text" : "text-warn-text"}`}>{resendMsg.text}</div>
        )}
      </div>
    );
  }

  // ── CONFIRMED 態 ───────────────────────────────────────────────
  if (b.status === "CONFIRMED") {
    const countdown = b.handledAt ? Math.max(0, Date.parse(b.handledAt) + ROLLBACK_WINDOW_MS - now) : 0;
    return (
      <div className="mb-2 rounded-xl border-2 border-ok/50 bg-ok-soft p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ok-text inline-flex items-center gap-1 shrink-0">✓ 已確認（Apricot）</span>
          <span className="text-sm text-t1 font-medium truncate">
            {b.providerName} · {b.requestedDate} {slotText}
          </span>
          <a href="/bookings" className="ml-auto shrink-0 text-xs px-2.5 py-1 rounded-lg bg-ok text-white font-medium hover:opacity-90">
            去 /bookings 處理 →
          </a>
        </div>
        <div className="mt-1.5 text-xs text-t2 flex flex-wrap gap-x-3">
          {b.apricotApptId && (
            <span>
              Apricot 單號：<span className="font-mono text-t1">{b.apricotApptId}</span>
            </span>
          )}
          {b.handledByStaffName && <span>發起人：{b.handledByStaffName}</span>}
          {b.visitReasonCode && <span>Visit reason：{b.visitReasonCode}</span>}
          <span className="text-ok-text">確認訊息已自動發出</span>
        </div>
        {rollbackVisible && (
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void doRollback()}
              disabled={rollbackBusy || locked}
              title={locked ? "Send Lock：只有負責人才可以撤銷" : "撤銷代落單（Apricot 單會刪除，卡彈返 PENDING；唔會自動覆病人）"}
              className="text-xs px-3 py-1.5 rounded-lg border border-danger-text text-danger-text hover:bg-danger-soft disabled:opacity-40 inline-flex items-center gap-1"
            >
              <RotateCcw size={11} />
              {rollbackBusy ? "撤銷中…" : `撤銷（${formatMmSs(countdown)}）`}
            </button>
            {locked && (
              <span className="text-[10px] text-warn-text inline-flex items-center gap-1">
                <Lock size={10} /> 只限負責人撤銷（{c.assigneeName}）
              </span>
            )}
          </div>
        )}
        {!rollbackVisible && b.handledAt && (
          <div className="mt-1.5 text-[10px] text-t3">撤銷窗口已過 — 之後改動用側欄 Apricot 預約卡（改期/取消）</div>
        )}
        {confirmMsg && (
          <div className={`mt-1.5 text-xs ${confirmMsg.tone === "ok" ? "text-ok-text" : "text-warn-text"}`}>{confirmMsg.text}</div>
        )}
        {rollbackMsg && (
          <div className={`mt-1.5 text-xs ${rollbackMsg.tone === "ok" ? "text-ok-text" : "text-warn-text"}`}>{rollbackMsg.text}</div>
        )}
      </div>
    );
  }

  // REJECTED / EXPIRED（簡短顯示 — 隊列頁先處理）
  return (
    <div className="mb-2 rounded-xl border border-line bg-panel-2 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-t3 inline-flex items-center gap-1">
          <CalendarDays size={13} /> 預約請求（{b.status === "EXPIRED" ? "已過期" : "已拒絕"}）
        </span>
        <span className="text-sm text-t2 line-through truncate">
          {b.providerName} · {b.requestedDate} {slotText}
        </span>
      </div>
    </div>
  );
}
