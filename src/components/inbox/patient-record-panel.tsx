"use client";

/**
 * 病人記錄面板（followup-v2 §3 — cwi-followup-p2-20260915）
 *
 * 內容共享：手機半屏抽屜（§3.2）/ 桌面右側欄「病人記錄」分頁（§3.4）渲染同一份內容。
 *
 * 🔴 鐵律（§6 + 本單紅線）：
 *   - 臨床全文唔入 wa-inbox — 到診卡只顯示 firstLine（≤60 字，server 邊界已截）；
 *     全文即時經 GET /patient-record/note?visitId=（CWM 側 100% audit EXTERNAL_NOTE_VIEWED）
 *   - 收埋展開後**唔 cache**（note state 清 null — 再展開 = 再 call + 再 audit；§3.3 拍板 b）
 *   - UI 零原始電話 — 病人只以 patientCode（如 P0001）呈現
 *   - 刷新五態嚴格照 §3.1b（<1h 綠 / 1–24h 灰 / >24h 黃 / 更新中 / 失敗 503+lastSyncedAt）
 *     + 開面板 syncedAt>24h 自動靜默刷新（只一次，防循環）
 *   - 一個 syncedAt 管三個分頁（§3.1b）
 *
 * RBAC：requireAuth + assertConversationAccess 喺 route 側執行（SUPERVISOR 全店唯讀 /
 *   STAFF 自己範圍）— 本組件 GET-only + §4.6 opt-out toggle（PATCH；SUPERVISOR canEdit=false 唔渲染）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Pill } from "lucide-react";
import type { NoteText, PatientRecordData, PatientRecordVisit } from "./types";
import {
  REFRESH_COOLDOWN_MS,
  baseSyncState,
  fmtAmt,
  fmtDateShort,
  fmtSyncAt,
  refreshButton,
  syncDisplay,
  weeksAgoLabel,
  type RefreshPhase,
  type Tone,
} from "@/lib/patient-record-state";
import { WLoading } from "@/components/ui/w-loader";
import { PatientStatusChip } from "./patient-status-chip";

// ★ cwi-walkin-20261018（擁有人拍板）：預約同到診合併一個時間線；藥物併入「診症及處方」做子項
type TabKey = "visits" | "consult" | "bills";

const TABS: { key: TabKey; label: string }[] = [
  { key: "visits", label: "預約／到診" },
  { key: "consult", label: "診症及處方" },
  { key: "bills", label: "帳單" },
];

/** bookingStatus → 狀態 chip（§0.2 對照）。 */
const STATUS_CHIP: Record<number, { label: string; cls: string }> = {
  1: { label: "已到診", cls: "bg-brand-soft text-brand-text" },
  4: { label: "已完成", cls: "bg-ok-soft text-ok-text" },
  "-3": { label: "爽約", cls: "bg-danger-soft text-danger-text" },
  0: { label: "已約未到", cls: "bg-panel-2 text-t2" },
  102: { label: "改期", cls: "bg-warn-soft text-warn-text" },
};

function StatusChip({ status }: { status: number }) {
  const m = STATUS_CHIP[status] ?? { label: `狀態 ${status}`, cls: "bg-panel-2 text-t2" };
  return <span className={`px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap ${m.cls}`} data-e2e="p2-status-chip">{m.label}</span>;
}

const TONE_CLS: Record<Tone, string> = {
  green: "bg-ok-soft text-ok-text",
  gray: "bg-panel-2 text-t2",
  yellow: "bg-warn-soft text-warn-text",
  red: "bg-danger-soft text-danger-text",
};

interface Props {
  conversationId: string;
  /** 抽屜／分頁切換時重掛 = false（保持內部狀態）；對話切換靠 conversationId effect 重載。 */
  resetKey?: number;
}

export function PatientRecordPanel({ conversationId, resetKey = 0 }: Props) {
  const [data, setData] = useState<PatientRecordData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<RefreshPhase>({ kind: "idle" });
  const [tab, setTab] = useState<TabKey>("visits");
  const [now, setNow] = useState(() => Date.now());
  // 展開臨床記錄（S4）— note 收埋即清（唔 cache）
  const [expandedVisitId, setExpandedVisitId] = useState<string | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteData, setNoteData] = useState<NoteText | null>(null);
  // §4.6 跟進通知 toggle（病人卡 — MD 手動 toggle；contact 級）
  const [optOutBusy, setOptOutBusy] = useState(false);
  // ★ cwi-followup-v3 B-9：稱呼/locale 人手編輯（系統唔自動估 — AI 唔准由名估性別）
  const [salutationDraft, setSalutationDraft] = useState<string | null>(null);
  const [salBusy, setSalBusy] = useState(false);
  // 自動靜默刷新只一次（per conversation）— 防循環
  const autoRanFor = useRef<string | null>(null);

  const load = useCallback(
    async (refresh: boolean, silent: boolean) => {
      if (refresh) setPhase({ kind: "refreshing", silent });
      try {
        const res = await fetch(`/api/conversations/${conversationId}/patient-record${refresh ? "?refresh=1" : ""}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as PatientRecordData;
        setData(j);
        setLoadError(null);
        setNow(Date.now());
        if (refresh) {
          const rf = j.refresh;
          if (!rf) setPhase({ kind: "idle" }); // 無病人可刷新 — 唔會卡 refreshing
          else if (rf.state === "ok") setPhase({ kind: "cooldown", readyAt: Date.now() + REFRESH_COOLDOWN_MS });
          else if (rf.state === "rate_limited")
            setPhase({ kind: "rate_limited", readyAt: Date.now() + rf.retryAfterSec * 1000, retryAfterSec: rf.retryAfterSec });
          else setPhase({ kind: "failed" }); // 503/網絡斷 — 保護 4：唔扮成功，顯示舊 syncedAt
        }
      } catch {
        if (refresh) setPhase({ kind: "failed" });
        else setLoadError("載入病人記錄失敗");
      } finally {
        setLoading(false);
      }
    },
    [conversationId],
  );

  // §4.6：跟進通知 toggle（手動 — opt-out 永遠優先；唔影響病人主動查詢嘅正常回覆）
  const toggleOptOut = useCallback(async () => {
    const c = data?.contact;
    if (!c || !c.canEdit || optOutBusy) return;
    const next = !c.followupOptOut;
    // ★ wa-meta-compliance-20261016（B.3）：重新啟用必須記錄病人同意嘅用途（來源/時間/用途 三要素）—
    //   UI prompt 收集（例：「10/15 WhatsApp 回覆『可以繼續發』」）；空 = 唔可以啟用。
    let purpose: string | null = null;
    if (!next) {
      purpose = window.prompt(
        "重新啟用主動跟進需要記錄病人同意（合規要求）。\n請填寫：病人何時/點同意再收跟進？（例：10/15 WhatsApp 回覆「可以繼續發」）"
      );
      if (purpose === null) return; // 取消
      purpose = purpose.trim();
      if (!purpose) {
        alert("請填寫病人同意嘅來源/用途，否則唔可以重新啟用。");
        return;
      }
    }
    setOptOutBusy(true);
    try {
      const res = await fetch(`/api/followups/contacts/${c.id}/opt-out`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next ? { optOut: true } : { optOut: false, consent: { purpose } }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      setData((prev) =>
        prev && prev.contact
          ? {
              ...prev,
              contact: { ...prev.contact, followupOptOut: next, optOutSource: next ? "manual" : null, optOutAt: next ? new Date().toISOString() : null },
            }
          : prev
      );
    } catch (e) {
      alert(`跟進通知更新失敗，請稍後再試${e instanceof Error && e.message ? `（${e.message}）` : ""}`);
    } finally {
      setOptOutBusy(false);
    }
  }, [data, optOutBusy]);

  // ★ wa-meta-compliance-20261016（C.1）：交返 AI — 清 patientRequestedHuman flag（audit HUMAN_REQUEST_CLEARED）
  const [handBackBusy, setHandBackBusy] = useState(false);
  const handBackToAi = useCallback(async () => {
    if (handBackBusy) return;
    setHandBackBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/patient-requested-human`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      setData((prev) =>
        prev && prev.patientRequestedHuman
          ? { ...prev, patientRequestedHuman: { ...prev.patientRequestedHuman, active: false, at: null } }
          : prev
      );
    } catch (e) {
      alert(`交返 AI 失敗，請稍後再試${e instanceof Error && e.message ? `（${e.message}）` : ""}`);
    } finally {
      setHandBackBusy(false);
    }
  }, [conversationId, handBackBusy]);

  // ★ cwi-inbox-r3：ADMIN 專用「刪除病人資料」（POST /api/admin/contacts/[id]/delete — 不可還原）
  // 兩步：撳掣 → 頁內確認框（打「刪除」+ 可選原因）→ 執行；成功後返 /inbox 重載（對話已一併刪除）
  const [delOpen, setDelOpen] = useState(false);
  const [delConfirm, setDelConfirm] = useState("");
  const [delReason, setDelReason] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const deletePatient = useCallback(async () => {
    const c = data?.contact;
    if (!c?.canDelete || delBusy || delConfirm.trim() !== "刪除") return;
    setDelBusy(true);
    setDelError(null);
    try {
      const res = await fetch(`/api/admin/contacts/${c.id}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delReason.trim() ? { reason: delReason.trim().slice(0, 300) } : {}),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      window.location.assign("/inbox");
    } catch (e) {
      setDelError(`刪除失敗${e instanceof Error && e.message ? `（${e.message}）` : ""}`);
      setDelBusy(false);
    }
  }, [data, delBusy, delConfirm, delReason]);
  useEffect(() => {
    setDelOpen(false);
    setDelConfirm("");
    setDelReason("");
    setDelError(null);
  }, [conversationId]);

  // ★ cwi-patient-identify-20261017：重新判定新客／舊客（即刻再搜晒全部 Apricot 帳號）
  const [identBusy, setIdentBusy] = useState(false);
  const reIdentify = useCallback(async () => {
    const c = data?.contact;
    if (!c || identBusy) return;
    setIdentBusy(true);
    try {
      const res = await fetch(`/api/contacts/${c.id}/identify`, { method: "POST" });
      if (res.ok) await load(false, false); // 判定結果可能改咗配對病人 → 重載成張卡
    } finally {
      setIdentBusy(false);
    }
  }, [data, identBusy, load]);

  // ★ cwi-followup-v3 B-9：存稱呼 + locale（PATCH /api/contacts/:id — staff+）
  const saveSalutation = useCallback(
    async (salutation: string | null, locale: string | null) => {
      const c = data?.contact;
      if (!c || !c.canEdit || salBusy) return;
      setSalBusy(true);
      try {
        const res = await fetch(`/api/contacts/${c.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ salutation: salutation?.trim() || null, locale }),
        });
        if (!res.ok) return;
        const updated = (await res.json()) as { salutation: string | null; locale: string | null };
        setData((prev) =>
          prev && prev.contact ? { ...prev, contact: { ...prev.contact, salutation: updated.salutation, locale: updated.locale } } : prev
        );
        setSalutationDraft(null);
      } finally {
        setSalBusy(false);
      }
    },
    [data, salBusy]
  );

  // 對話切換 / resetKey → 全新載入（展開狀態清晒）
  useEffect(() => {
    setData(null);
    setLoadError(null);
    setPhase({ kind: "idle" });
    setExpandedVisitId(null);
    setNoteData(null);
    setNoteError(null);
    setLoading(true);
    void load(false, false);
  }, [conversationId, resetKey, load]);

  // 倒數 tick（cooldown / rate_limited 60s 口徑）
  useEffect(() => {
    if (phase.kind !== "cooldown" && phase.kind !== "rate_limited") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase.kind]);
  // 倒數完 → 返 idle（掣再得用）
  useEffect(() => {
    if ((phase.kind === "cooldown" || phase.kind === "rate_limited") && now >= phase.readyAt) setPhase({ kind: "idle" });
  }, [phase, now]);

  // §3.1b：開面板 >24h → 自動靜默刷新（只一次）
  useEffect(() => {
    if (loading || !data?.patient) return;
    if (autoRanFor.current === conversationId) return;
    if (baseSyncState(data.syncedAt, Date.now()) === "stale") {
      autoRanFor.current = conversationId;
      void load(true, true);
    }
  }, [loading, data, conversationId, load]);

  // 展開／收埋臨床記錄（S4 — 每次展開 = 一新 call；收埋清 state 唔 cache）
  const toggleNote = useCallback(
    async (visit: PatientRecordVisit) => {
      if (expandedVisitId === visit.visitId) {
        setExpandedVisitId(null);
        setNoteData(null);
        setNoteError(null);
        return;
      }
      setExpandedVisitId(visit.visitId);
      setNoteData(null);
      setNoteError(null);
      setNoteLoading(true);
      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/patient-record/note?visitId=${encodeURIComponent(visit.visitId)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        setNoteData(j.note as NoteText);
      } catch {
        setNoteError("臨床記錄載入失敗（可再撳重試）");
      } finally {
        setNoteLoading(false);
      }
    },
    [conversationId, expandedVisitId],
  );

  const base = data ? baseSyncState(data.syncedAt, now) : "none";
  const display = syncDisplay(base, data?.syncedAt ?? null, phase, now);
  const btn = refreshButton(base, phase, now);

  return (
    <div data-e2e="p2-panel" className="flex flex-col min-h-0 h-full bg-canvas">
      {/* 刷新列（§3.1b 五態常駐） */}
      <div className={`shrink-0 px-2.5 py-1.5 flex items-center gap-2 ${TONE_CLS[display.tone]}`} data-e2e="p2-syncbar">
        <span className="text-[11px] flex-1 min-w-0 truncate">{display.text}</span>
        <button
          data-e2e="p2-refresh-btn"
          disabled={btn.disabled}
          onClick={() => void load(true, false)}
          className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-panel border border-line text-t1 hover:bg-panel-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {btn.label}
        </button>
      </div>

      {loadError && !data ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-t3 p-6" data-e2e="p2-load-error">
          <span className="text-[12px]">{loadError}</span>
          <button onClick={() => void load(false, false)} className="text-[11px] px-3 py-1 rounded-full bg-panel-2 text-t1">
            重試
          </button>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center text-t3" data-e2e="p2-loading">
          <WLoading label="載入緊病人記錄…" />
        </div>
      ) : null}

      {data && !data.patient ? (
        <div className="flex-1 flex items-center justify-center text-center p-6" data-e2e="p2-no-patient">
          <div className="text-[12px] text-t3">
            暫時配唔到病人記錄
            <div className="text-[11px] mt-1">
              呢個對話未釘住病人、預約索引窗內又冇配對 — 可喺詳情「病人」卡手動釘住
            </div>
          </div>
        </div>
      ) : null}

      {/* ★ cwi-patient-identify：新客／舊客（電話直接搜晒全部 Apricot 帳號；唔使有預約） */}
      {data?.contact ? (
        <div className="shrink-0 mx-2.5 mt-1.5 px-2 py-1.5 rounded-lg bg-panel-2 flex items-center justify-between gap-2 text-[11px]" data-e2e="identify-row">
          <span className="text-t2 inline-flex items-center gap-1.5 min-w-0">
            新客／舊客：
            <PatientStatusChip status={data.contact.patientStatus ?? null} count={data.contact.identifiedCount ?? null} />
            {data.contact.patientStatus === "EXISTING" && (data.contact.identifiedCount ?? 0) > 1 ? (
              <span className="text-t3 truncate">同一電話有 {data.contact.identifiedCount} 個病人檔 — 喺「病人」卡揀邊個</span>
            ) : null}
          </span>
          <button
            type="button"
            disabled={identBusy}
            onClick={() => void reIdentify()}
            className="shrink-0 px-2 py-0.5 rounded-md border border-line bg-panel text-t2 hover:bg-panel-2 disabled:opacity-50"
            data-e2e="identify-retry"
          >
            {identBusy ? <WLoading size="inline" label="搜緊…" /> : "重新判定"}
          </button>
        </div>
      ) : null}

      {/* §4.6 跟進通知（病人卡 toggle — contact 級，未配對都顯示；SUPERVISOR 唯讀唔渲染掣） */}
      {data?.contact ? (
        <div className="shrink-0 mx-2.5 mt-1.5 px-2 py-1.5 rounded-lg bg-panel-2 flex items-center justify-between text-[11px]" data-e2e="p3-optout-row">
          <span className="text-t2">
            跟進通知{data.contact.followupOptOut ? "（已停止 — 病人 opt-out）" : ""}
          </span>
          {data.contact.canEdit ? (
            <button
              data-e2e="p3-optout-toggle"
              disabled={optOutBusy}
              onClick={() => void toggleOptOut()}
              className={`px-2 py-0.5 rounded-md border text-[11px] disabled:opacity-50 ${
                data.contact.followupOptOut
                  ? "bg-danger-soft text-danger-text border-danger-text/30"
                  : "bg-panel text-t2 border-line hover:bg-panel-2"
              }`}
            >
              {optOutBusy ? "更新中…" : data.contact.followupOptOut ? "恢復跟進" : "停止跟進"}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ★ wa-meta-compliance-20261016（C.1）：病人要求真人 → AI 自動收聲（staff「交返 AI」清旗） */}
      {data?.patientRequestedHuman?.active ? (
        <div
          className="shrink-0 mx-2.5 mt-1.5 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-2 text-[11px]"
          data-e2e="c1-human-request-row"
        >
          <span className="text-amber-600 min-w-0">
            病人要求真人跟進 — AI 自動覆已暫停
            {data.patientRequestedHuman.at ? `（${new Date(data.patientRequestedHuman.at).toLocaleString()}）` : ""}
          </span>
          {data.patientRequestedHuman.canClear ? (
            <button
              data-e2e="c1-hand-back-btn"
              disabled={handBackBusy}
              onClick={() => void handBackToAi()}
              className="shrink-0 px-2 py-0.5 rounded-md border border-amber-500/40 bg-panel text-t1 hover:bg-panel-2 disabled:opacity-50"
            >
              {handBackBusy ? "處理中…" : "交返 AI 繼續"}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ★ cwi-followup-v3 B-9：稱呼（人手可改 — 系統唔自動估，AI 唔准由名估性別）+ 語言（決定 *_en template） */}
      {data?.contact ? (
        <div className="shrink-0 mx-2.5 mt-1.5 px-2 py-1.5 rounded-lg bg-panel-2 flex items-center justify-between gap-2 text-[11px]" data-e2e="b9-salutation-row">
          <span className="text-t2 shrink-0">稱呼</span>
          {data.contact.canEdit ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <input
                data-e2e="b9-salutation-input"
                value={salutationDraft ?? data.contact.salutation ?? ""}
                onChange={(e) => setSalutationDraft(e.target.value)}
                placeholder="先生／小姐（空 = 您）"
                maxLength={50}
                className="w-28 min-w-0 text-[11px] px-2 py-0.5 rounded-md bg-panel border border-line text-t1 placeholder:text-t3"
              />
              <select
                data-e2e="b9-locale-select"
                value={data.contact.locale ?? "zh"}
                onChange={(e) => void saveSalutation(salutationDraft ?? data.contact.salutation, e.target.value === "zh" ? null : "en")}
                className="text-[11px] px-1 py-0.5 rounded-md bg-panel border border-line text-t1"
                title="template 語言（en = 用 *_en 模板，如有）"
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
              <button
                data-e2e="b9-salutation-save"
                disabled={salBusy || (salutationDraft ?? data.contact.salutation ?? "") === (data.contact.salutation ?? "")}
                onClick={() => void saveSalutation(salutationDraft ?? data.contact.salutation, data.contact.locale)}
                className="shrink-0 text-[11px] px-2 py-0.5 rounded-md bg-brand text-panel font-medium disabled:opacity-40"
              >
                {salBusy ? "存緊…" : "存"}
              </button>
            </div>
          ) : (
            <span className="text-t1" data-e2e="b9-salutation-value">{data.contact.salutation ?? "您"}</span>
          )}
        </div>
      ) : null}

      {data?.patient ? (
        <>
          {data.degraded ? (
            <div className="shrink-0 mx-2.5 mt-1.5 px-2 py-1 rounded-lg bg-warn-soft text-warn-text text-[10px]">
              部分資料暫時取唔到（workforce 降級中），其餘照常顯示
            </div>
          ) : null}
          {/* 病人頭（patientCode — 零原始電話） */}
          <div className="shrink-0 px-3 pt-2 pb-1 flex items-center gap-1.5 text-[11px]">
            <span className="font-medium text-t1" data-e2e="p2-patient-code">
              {data.patient.patientCode ?? "—"}
            </span>
            <span className="text-t3">·</span>
            <span className="text-t2">{data.patient.source === "pinned" ? "已釘住" : data.patient.source === "identified" ? "電話認到" : "預約配對"}</span>
          </div>
          {/* ★ cwi-ux UX-07：最近到診分店 + 主診醫生（近 12 個月）— 冇記錄唔顯示（spec：T-UX07i） */}
          {data.visitStats ? (
            <div className="shrink-0 px-3 pb-1 space-y-0.5 text-[11px]">
              {data.visitStats.latestVisit ? (
                <div className="text-t2" data-e2e="p2-last-visit-row">
                  最近到診：{" "}
                  <span className="font-medium text-t1">{data.visitStats.latestVisit.clinicCode}</span>
                  {" · "}
                  <span className="font-medium text-t1">
                    {data.visitStats.latestVisit.providerName ?? "—"}
                  </span>
                  {`（${weeksAgoLabel(data.visitStats.latestVisit.date, now)}）`}
                </div>
              ) : null}
              {data.visitStats.primaryDoctor ? (
                <div className="text-t2" data-e2e="p2-primary-doctor-row">
                  主診醫生：{" "}
                  <span className="font-medium text-t1">
                    {data.visitStats.primaryDoctor.providerName ?? data.visitStats.primaryDoctor.providerCode}
                  </span>
                  {`（近 12 個月 ${data.visitStats.primaryDoctor.count}/${data.visitStats.totalVisits12m} 次）`}
                </div>
              ) : null}
            </div>
          ) : null}
          {/* 三分頁（預約／到診・診症及處方・帳單） */}
          <div className="shrink-0 flex gap-1 px-2.5 pb-1.5" data-e2e="p2-tabbar">
            {TABS.map((t) => (
              <button
                key={t.key}
                data-e2e={`p2-tab-${t.key}`}
                onClick={() => setTab(t.key)}
                className={`flex-1 py-1 rounded-lg text-[11px] border ${
                  tab === t.key
                    ? "bg-brand text-white border-brand font-medium"
                    : "bg-panel text-t2 border-line hover:bg-panel-2"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* 內容區獨立捲動（§3.2：唔會連對話一齊捲） */}
          <div className="flex-1 overflow-y-auto min-h-0 px-2.5 pb-3 space-y-2" data-e2e="p2-content">
            {tab === "visits" ? (
              /* ★ cwi-walkin-20261018：預約＋到診一條時間線（新→舊）。同日同店已有到診行嘅預約唔重複出 */
              (() => {
                const visitKeys = new Set(data.visits.map((v) => `${v.visitDate}|${v.clinicCode}`));
                const appts = data.appointments.filter((a) => !visitKeys.has(`${a.date}|${a.clinicCode}`));
                const items = [
                  ...appts.map((a) => ({ kind: "appt" as const, date: a.date, appt: a })),
                  ...data.visits.map((v) => ({ kind: "visit" as const, date: v.visitDate, visit: v })),
                ].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
                return items.length === 0 ? (
                  <div className="text-center py-10 text-[12px] text-t3">索引窗內冇預約或到診記錄</div>
                ) : (
                  items.map((it) =>
                    it.kind === "appt" ? (
                      <ApptRow key={`a-${it.appt.apricotApptId}`} appt={it.appt} />
                    ) : (
                      <VisitCard key={it.visit.visitId} visit={it.visit} expanded={expandedVisitId === it.visit.visitId} noteLoading={noteLoading} noteError={noteError} noteData={noteData} onToggle={() => void toggleNote(it.visit)} />
                    ),
                  )
                );
              })()
            ) : null}
            {tab === "consult" ? (
              /* ★ cwi-walkin-20261018：診症及處方 — 每次到診嘅臨床記錄（主訴／檢查／診斷／處理）+ 處方；
                 全文仍然展開先拉（CWM audit），藥物 code 喺卡面直接顯示 */
              data.visits.some((v) => v.hasNote || (v.rxCodes ?? []).length > 0) ? (
                data.visits
                  .filter((v) => v.hasNote || (v.rxCodes ?? []).length > 0)
                  .map((v) => (
                    <VisitCard key={v.visitId} visit={v} showRx expanded={expandedVisitId === v.visitId} noteLoading={noteLoading} noteError={noteError} noteData={noteData} onToggle={() => void toggleNote(v)} />
                  ))
              ) : (
                <div className="text-center py-10" data-e2e="p2-consult-empty">
                  <Pill size={20} className="mx-auto mb-2 opacity-40 text-t3" />
                  <div className="text-[12px] text-t2">索引窗內冇診症記錄</div>
                  <div className="text-[11px] text-t3 mt-1">到診後撳「立即更新」由 Apricot 攞最新臨床記錄同處方</div>
                </div>
              )
            ) : null}
            {tab === "bills" ? (
              /* 帳單：#6 只回 ttlAmt/osAmt 總額 — 總額卡（已拍板） */
              data.balance ? (
                <div className="bg-panel border border-line rounded-xl p-3" data-e2e="p2-balance-card">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-t2">總帳單額</span>
                    <span className="font-medium text-t1">{fmtAmt(data.balance.balance.ttlAmt)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[12px] mt-1.5">
                    <span className="text-t2">未結餘額</span>
                    <span className="font-semibold text-t1" data-e2e="p2-balance-os">
                      {fmtAmt(data.balance.balance.osAmt)}
                    </span>
                  </div>
                  <div className="text-[10px] text-t3 mt-2">
                    截至 {fmtDateShort(data.balance.asOf)} · 資料同步 {fmtSyncAt(data.syncedAt)}
                  </div>
                </div>
              ) : (
                <div className="text-center py-10 text-[12px] text-t3">冇帳單數據</div>
              )
            ) : null}
          </div>
        </>
      ) : null}

      {/* ★ cwi-inbox-r3：ADMIN 專用 — 刪除病人資料（病人要求刪除 → 核實身份後執行；不可還原） */}
      {data?.contact?.canDelete ? (
        <div className="shrink-0 mx-2.5 my-2 rounded-lg border border-danger/40 px-2 py-1.5 text-[11px]" data-e2e="admin-delete-patient">
          {!delOpen ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-t3">病人要求刪除資料（ADMIN）</span>
              <button
                type="button"
                onClick={() => setDelOpen(true)}
                className="px-2 py-0.5 rounded-md border border-danger-text/30 bg-danger-soft text-danger-text text-[11px]"
              >
                刪除病人資料
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="text-danger-text font-semibold">
                永久刪除 {data.contact.profileName || "呢個病人"} 嘅所有對話、訊息、媒體、預約暫存同同意記錄 — 不可還原
              </div>
              <div className="text-t3">（資料庫備份 ≤30 日內仍可能保留，到期後徹底消失；Apricot 病歷唔受影響）</div>
              <input
                value={delReason}
                maxLength={300}
                onChange={(e) => setDelReason(e.target.value)}
                placeholder="原因（可選）例：病人 WhatsApp 要求，已核實身份"
                className="w-full rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-t1"
              />
              <input
                value={delConfirm}
                onChange={(e) => setDelConfirm(e.target.value)}
                placeholder="打「刪除」確認"
                aria-label="打刪除確認"
                className="w-full rounded-md border border-danger/40 bg-panel px-2 py-1 text-[11px] text-t1"
              />
              {delError ? <div className="text-danger-text">{delError}</div> : null}
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  disabled={delBusy}
                  onClick={() => {
                    setDelOpen(false);
                    setDelConfirm("");
                    setDelError(null);
                  }}
                  className="px-2 py-0.5 rounded-md border border-line text-t2 text-[11px]"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={delBusy || delConfirm.trim() !== "刪除"}
                  onClick={() => void deletePatient()}
                  className="px-2 py-0.5 rounded-md bg-danger text-white text-[11px] font-semibold disabled:opacity-40"
                  data-e2e="admin-delete-confirm"
                >
                  {delBusy ? "刪除緊…" : "確認永久刪除"}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 預約行（未到診／未來 — 已有到診行嘅同日預約唔出）。 */
function ApptRow({ appt: a }: { appt: PatientRecordData["appointments"][number] }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-2.5" data-e2e="p2-appt-row">
      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="font-medium text-t1">{fmtDateShort(a.date)}</span>
        <span className="text-t2">
          {a.start}–{a.end}
        </span>
        <span className="text-t3">·</span>
        <span className="text-t2">{a.clinicCode}</span>
        <span className="text-t3">·</span>
        <span className="text-t2">{a.providerName || "—"}</span>
        <StatusChip status={a.bookingStatus} />
      </div>
      {a.visitReasons.length > 0 ? <div className="mt-1 text-[11px] text-t3">{a.visitReasons.join(" / ")}</div> : null}
    </div>
  );
}

function VisitCard({
  visit,
  showRx = false,
  expanded,
  noteLoading,
  noteError,
  noteData,
  onToggle,
}: {
  visit: PatientRecordVisit;
  /** 「診症及處方」分頁：卡面顯示藥物 code（CWM 字典映名 + 抗生素旗） */
  showRx?: boolean;
  expanded: boolean;
  noteLoading: boolean;
  noteError: string | null;
  noteData: NoteText | null;
  onToggle: () => void;
}) {
  const rxCodes = visit.rxCodes ?? [];
  return (
    <div className="bg-panel border border-line rounded-xl p-2.5" data-e2e="p2-visit-card" data-visit-id={visit.visitId}>
      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="font-medium text-t1">{fmtDateShort(visit.visitDate)}</span>
        {visit.visitReasonCodes.length > 0 ? <span className="text-t2">{visit.visitReasonCodes.join(" / ")}</span> : null}
        <span className="text-t3">·</span>
        <span className="text-t2">{visit.clinicCode}</span>
        <span className="text-t3">·</span>
        <span className="text-t2">{visit.providerName ?? visit.providerCode ?? "—"}</span>
        <StatusChip status={visit.bookingStatus} />
      </div>
      {visit.firstLine ? <div className="mt-1 text-[12px] text-t1" data-e2e="p2-first-line">{visit.firstLine}</div> : null}
      {showRx && rxCodes.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1" data-e2e={`p2-meds-${visit.visitId}`}>
          {rxCodes.map((rx) => (
            <span key={rx.code} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-panel-2 text-[11px]" data-e2e={`p2-rx-${visit.visitId}-${rx.code}`}>
              <Pill size={11} className="text-brand-text shrink-0" />
              <span className="text-t1">{rx.name}</span>
              {rx.isAntibiotic && <span className="px-1 rounded text-[9px] bg-danger-soft text-danger-text">抗生素</span>}
            </span>
          ))}
        </div>
      ) : null}
      {visit.hasNote ? (
        <button
          data-e2e="p2-expand-note"
          data-visit-id={visit.visitId}
          onClick={onToggle}
          className="mt-1.5 inline-flex items-center gap-0.5 text-[11px] text-brand hover:underline"
        >
          {expanded ? (
            <>
              收埋臨床記錄 <ChevronUp size={12} strokeWidth={2.75} />
            </>
          ) : (
            <>
              展開臨床記錄 <ChevronDown size={12} strokeWidth={2.75} />
            </>
          )}
        </button>
      ) : null}
      {expanded ? (
        <div className="mt-2 border-t border-line pt-2" data-e2e="p2-note">
          {noteLoading ? (
            <div className="flex items-center gap-1.5 text-[11px] text-t3 py-1">
              <WLoading size="inline" label="載入臨床記錄…" />
            </div>
          ) : null}
          {noteError ? <div className="text-[11px] text-danger-text" data-e2e="p2-note-error">{noteError}</div> : null}
          {noteData ? (
            <NoteBody note={noteData} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 兩種樣板渲染（MD §0.3 — 自訂樣板 Tx 原文保留換行）。 */
function NoteBody({ note }: { note: NoteText }) {
  return (
    <div data-e2e="p2-note" data-kind={note.kind}>
      {note.kind === "STANDARD" ? (
        /* ★ cwi-walkin-20261018：Apricot 四欄（Complaints／Findings／Diagnosis／Actions）全部列出 — 空欄顯示「—」 */
        <dl className="space-y-1.5">
          {[
            ["主訴", note.complaints],
            ["檢查所見", note.findings],
            ["診斷", note.diagnosis],
            ["治療處理", note.actions],
          ].map(([label, text]) => (
            <div key={label} className="text-[12px]">
              <dt className="text-t3">{label}</dt>
              <dd className={`whitespace-pre-wrap ${text?.trim() ? "text-t1" : "text-t3"}`}>{text?.trim() ? text : "—"}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="space-y-1.5">
          {note.templateName ? <div className="text-[10px] text-t3">樣板：{note.templateName}</div> : null}
          {note.blocks.map((b, i) => (
            <div key={i} className="text-[12px]">
              <span className="text-t3">{b.label}：</span>
              <span className="text-t1 whitespace-pre-wrap">{b.text}</span>
            </div>
          ))}
        </div>
      )}
      {/* ★ cwi-walkin-20261018：處方（Prescription）— 冇處方都講明 */}
      <div className="mt-2 pt-1.5 border-t border-line" data-e2e="p2-note-rx">
        <div className="text-[12px] text-t3">處方</div>
        {note.rx && note.rx.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5">
            {note.rx.map((r, i) => (
              <li key={i} className="text-[12px] flex gap-1.5">
                <Pill size={12} className="text-brand-text shrink-0 mt-0.5" />
                <span>
                  <span className="text-t1">{r.name}</span>
                  {r.detail ? <span className="block text-[11px] text-t2">{r.detail}</span> : null}
                  {r.caution ? <span className="block text-[11px] text-warn-text">⚠ {r.caution}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[12px] text-t3">—（冇處方）</div>
        )}
      </div>
      <p className="mt-2 text-[10px] text-t3" data-e2e="p2-note-warn">
        呢啲係醫生臨床記錄，請勿轉發
      </p>
    </div>
  );
}


