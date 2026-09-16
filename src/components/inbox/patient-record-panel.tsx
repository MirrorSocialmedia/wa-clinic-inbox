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
import { ChevronDown, ChevronUp, Loader2, Pill } from "lucide-react";
import type { NoteText, PatientRecordData, PatientRecordVisit } from "./types";
import {
  REFRESH_COOLDOWN_MS,
  baseSyncState,
  fmtAmt,
  fmtDateShort,
  fmtSyncAt,
  refreshButton,
  syncDisplay,
  type RefreshPhase,
  type Tone,
} from "@/lib/patient-record-state";

type TabKey = "visits" | "meds" | "bills" | "appts";

const TABS: { key: TabKey; label: string }[] = [
  { key: "visits", label: "到診" },
  { key: "meds", label: "藥物" },
  { key: "bills", label: "帳單" },
  { key: "appts", label: "預約" },
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
    setOptOutBusy(true);
    try {
      const res = await fetch(`/api/followups/contacts/${c.id}/opt-out`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optOut: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((prev) =>
        prev && prev.contact
          ? {
              ...prev,
              contact: { ...prev.contact, followupOptOut: next, optOutSource: next ? "manual" : null, optOutAt: next ? new Date().toISOString() : null },
            }
          : prev
      );
    } catch {
      alert("跟進通知更新失敗，請稍後再試");
    } finally {
      setOptOutBusy(false);
    }
  }, [data, optOutBusy]);

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
          <Loader2 size={18} className="animate-spin" />
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
            <span className="text-t2">{data.patient.source === "pinned" ? "已釘住" : "自動配對"}</span>
          </div>
          {/* 四分頁 */}
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
              data.visits.length === 0 ? (
                <div className="text-center py-10 text-[12px] text-t3">索引窗內冇到診記錄</div>
              ) : (
                data.visits.map((v) => (
                  <VisitCard key={v.visitId} visit={v} expanded={expandedVisitId === v.visitId} noteLoading={noteLoading} noteError={noteError} noteData={noteData} onToggle={() => void toggleNote(v)} />
                ))
              )
            ) : null}
            {tab === "meds" ? (
              /* 藥物：P1 契約無藥物欄（#4 唔回 rxCodes）— empty-state 指引（已拍板） */
              <div className="text-center py-10" data-e2e="p2-meds-empty">
                <Pill size={20} className="mx-auto mb-2 opacity-40 text-t3" />
                <div className="text-[12px] text-t2">藥物資訊寫喺臨床記錄內</div>
                <div className="text-[11px] text-t3 mt-1">喺「到診」分頁撳「展開臨床記錄」查看</div>
              </div>
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
                    <span className="text-t2">欠款</span>
                    <span
                      className={`font-semibold ${
                        (data.balance.balance.osAmt ?? 0) > 0 ? "text-danger-text" : "text-ok-text"
                      }`}
                      data-e2e="p2-balance-os"
                    >
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
            {tab === "appts" ? (
              data.appointments.length === 0 ? (
                <div className="text-center py-10 text-[12px] text-t3">索引窗內冇預約</div>
              ) : (
                data.appointments.map((a) => (
                  <div key={a.apricotApptId} className="bg-panel border border-line rounded-xl p-2.5" data-e2e="p2-appt-row">
                    <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                      <span className="font-medium text-t1">{fmtDateShort(a.date)}</span>
                      <span className="text-t2">
                        {a.start}–{a.end}
                      </span>
                      <span className="text-t3">·</span>
                      <span className="text-t2">{a.providerName || "—"}</span>
                      <StatusChip status={a.bookingStatus} />
                    </div>
                    {a.visitReasons.length > 0 ? (
                      <div className="mt-1 text-[11px] text-t3">{a.visitReasons.join(" / ")}</div>
                    ) : null}
                  </div>
                ))
              )
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function VisitCard({
  visit,
  expanded,
  noteLoading,
  noteError,
  noteData,
  onToggle,
}: {
  visit: PatientRecordVisit;
  expanded: boolean;
  noteLoading: boolean;
  noteError: string | null;
  noteData: NoteText | null;
  onToggle: () => void;
}) {
  return (
    <div className="bg-panel border border-line rounded-xl p-2.5" data-e2e="p2-visit-card" data-visit-id={visit.visitId}>
      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="font-medium text-t1">{fmtDateShort(visit.visitDate)}</span>
        {visit.visitReasonCodes.length > 0 ? <span className="text-t2">{visit.visitReasonCodes.join(" / ")}</span> : null}
        <span className="text-t3">·</span>
        <span className="text-t2">{visit.providerName ?? visit.providerCode ?? "—"}</span>
        <StatusChip status={visit.bookingStatus} />
      </div>
      {visit.firstLine ? <div className="mt-1 text-[12px] text-t1" data-e2e="p2-first-line">{visit.firstLine}</div> : null}
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
              <Loader2 size={12} className="animate-spin" /> 載入臨床記錄…
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
        <dl className="space-y-1.5">
          {[
            ["主訴", note.complaints],
            ["癥狀", note.findings],
            ["診斷", note.diagnosis],
            ["跟進", note.actions],
          ].map(([label, text]) =>
            text ? (
              <div key={label} className="text-[12px]">
                <dt className="inline text-t3">{label}：</dt>
                <dd className="inline text-t1">{text}</dd>
              </div>
            ) : null,
          )}
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
      <p className="mt-2 text-[10px] text-t3" data-e2e="p2-note-warn">
        呢啲係醫生臨床記錄，請勿轉發
      </p>
    </div>
  );
}


