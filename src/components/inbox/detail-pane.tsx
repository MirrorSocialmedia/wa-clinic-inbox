"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Sparkles, Stethoscope, X } from "lucide-react";
import Link from "next/link";
import type { ConversationItem, ConvStatus, DutyInfo, PatientAppointment, PatientContext, PatientMatch, StaffInfo } from "./types";
import { relTime } from "./time";

interface Props {
  conversation: ConversationItem | null;
  staff: StaffInfo[];
  onPatch: (body: { status?: ConvStatus; assigneeId?: string | null; urgent?: boolean }) => Promise<void>;
  /** Phase 4：今日當值（該對話嘅 clinic；null/空 → 隱藏卡） */
  duty?: DutyInfo | null;
  /** ★ H1：自己 staffId + 角色 — 判定 canManage（現任 assignee / ADMIN / unassigned 任何 STAFF） */
  myStaffId: string;
  userRole: "ADMIN" | "STAFF";
  /** ★ H1：轉交/派單/放返隊列 — POST /api/conversations/[id]/assign（INTERNAL note + AuditLog + socket） */
  onAssign: (toStaffId: string | null) => Promise<{ ok: boolean; error?: string }>;
  assignBusy: boolean;
  assignError: string | null;
  /** <lg：bottom sheet 開關（由 inbox-client 控制；桌面側欄常駐不受影響） */
  mobileOpen: boolean;
  onMobileClose: () => void;
  /** ★ booking-ui：patient-context 寫入（釘住/改期/取消）後通知 parent 重拉（對話卡/預約卡）— 同 socket booking:changed 雙保險 */
  onBookingUiChanged?: () => void;
  /** ★ booking-ui（C）：socket booking:changed / parent 重拉觸發 patient-context 重載 */
  ctxRefreshKey?: number;
}

const STATUS_SEG: { key: ConvStatus; label: string }[] = [
  { key: "OPEN", label: "處理中" },
  { key: "PENDING", label: "等回覆" },
  { key: "RESOLVED", label: "已解決" },
];

const INTENT_LABEL: Record<string, string> = {
  BOOKING_REQUEST: "預約",
  QUESTION: "查詢",
  URGENT_PAIN: "急症",
  OUT_OF_SCOPE: "離題",
  OTHER: "其他",
};
const URGENCY_META: Record<string, { label: string; cls: string }> = {
  LOW: { label: "緊急度 低", cls: "bg-panel text-t2" },
  MED: { label: "緊急度 中", cls: "bg-warn-soft text-warn-text" },
  HIGH: { label: "緊急度 高", cls: "bg-danger-soft text-danger-text font-semibold" },
};

/**
 * 側欄（桌面 lg+）/ bottom sheet（<lg）。內容共用（content 變量渲染兩次）。
 * 功能同 v2 一樣：contact 編輯 / AI 分析 / 當值 / 狀態 / assignee / meta。
 * sheet 用 absolute（相對 inbox-client 個 relative 容器），z-40 < toast z-50；
 * 撳背景 / 撳拉桿關閉（落拉手勢留之後）。
 */
export function DetailPane({
  conversation,
  staff,
  onPatch,
  duty,
  myStaffId,
  userRole,
  onAssign,
  assignBusy,
  assignError,
  mobileOpen,
  onMobileClose,
  onBookingUiChanged,
  ctxRefreshKey = 0,
}: Props) {
  const [name, setName] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // ★ booking-ui（A/E）：patient-context
  const [ctx, setCtx] = useState<PatientContext | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const [apptBusy, setApptBusy] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [apptNote, setApptNote] = useState<string | null>(null);

  // 故意只對 conversation?.id 敏感（conversation object identity 每次列表更新都變 — 入 deps 會過度重拉）
  // ctxRefreshKey = socket booking:changed / 寫入後 parent 重拉訊號
  useEffect(() => {
    setCtx(null);
    setCtxError(null);
    setConfirmCancelId(null);
    setApptNote(null);
    if (!conversation) return;
    let cancelled = false;
    setCtxLoading(true);
    fetch(`/api/conversations/${conversation.id}/patient-context`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as PatientContext;
      })
      .then((data) => {
        if (!cancelled) setCtx(data);
      })
      .catch((e) => {
        if (!cancelled) setCtxError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setCtxLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, ctxRefreshKey]);

  // 二次確認倒數（取消預約 3 秒內再撳先執行）
  useEffect(() => {
    if (!confirmCancelId) return;
    const t = setTimeout(() => setConfirmCancelId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmCancelId]);

  useEffect(() => {
    if (conversation?.contact) {
      setName(conversation.contact.profileName ?? "");
      setLabels(conversation.contact.labels ?? []);
      setNewLabel("");
      setDirty(false);
    }
  }, [conversation?.id, conversation?.contact?.profileName, conversation?.contact?.labels]);

  // sheet 開緊時鎖 body scroll（手機）
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  if (!conversation) {
    return (
      <aside className="w-[302px] shrink-0 border-l border-line bg-panel hidden lg:flex flex-col items-center justify-center text-t3 gap-2">
        <div className="w-12 h-12 rounded-full bg-panel-2" />
        <div className="text-xs">揀一個對話先見到聯絡人資料</div>
      </aside>
    );
  }

  const c = conversation;
  const clinicStaff = staff.filter((s) => !s.clinicId || s.clinicId === c.clinicId);

  async function saveContact() {
    if (!c?.contact || saving) return;
    setSaving(true);
    try {
      await fetch(`/api/contacts/${c.contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileName: name.trim() || null, labels }),
      });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(s: ConvStatus) {
    if (!c || c.status === s) return;
    await onPatch({ status: s });
  }

  // ★ booking-ui（A/E）：patient-context 操作（423 = Send Lock 非負責人）
  async function refreshCtx() {
    if (!c) return;
    try {
      const res = await fetch(`/api/conversations/${c.id}/patient-context`);
      if (res.ok) setCtx((await res.json()) as PatientContext);
    } catch {
      /* 下次拉取會補；socket booking:changed 都會觸發 */
    }
  }

  async function pinPatient(m: PatientMatch) {
    if (!c || pinBusy) return;
    setPinBusy(m.patientApricotId);
    setCtxError(null);
    try {
      const res = await fetch(`/api/conversations/${c.id}/patient-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientApricotId: m.patientApricotId, patientName: m.patientName }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      await refreshCtx();
      onBookingUiChanged?.();
    } catch (e) {
      setCtxError(e instanceof Error ? e.message : String(e));
    } finally {
      setPinBusy(null);
    }
  }

  async function unpinPatient() {
    if (!c) return;
    setPinBusy("unpin");
    setCtxError(null);
    try {
      const res = await fetch(`/api/conversations/${c.id}/patient-pin`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      await refreshCtx();
      onBookingUiChanged?.();
    } catch (e) {
      setCtxError(e instanceof Error ? e.message : String(e));
    } finally {
      setPinBusy(null);
    }
  }

  async function startReschedule(a: PatientAppointment) {
    if (!c || apptBusy) return;
    setApptBusy(a.apricotApptId);
    setApptNote(null);
    setCtxError(null);
    try {
      const res = await fetch(`/api/conversations/${c.id}/patient-appointments/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apricotApptId: a.apricotApptId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      setApptNote(j?.error ? null : `已發改期 Flow 畀病人（${a.date} ${a.start}）— 等病人揾新時段`);
      onBookingUiChanged?.();
    } catch (e) {
      setCtxError(e instanceof Error ? e.message : String(e));
    } finally {
      setApptBusy(null);
    }
  }

  async function cancelAppointment(a: PatientAppointment) {
    if (!c || apptBusy) return;
    // 二次確認：第一次撳 → 3 秒內再撳先執行
    if (confirmCancelId !== a.apricotApptId) {
      setConfirmCancelId(a.apricotApptId);
      return;
    }
    setConfirmCancelId(null);
    setApptBusy(a.apricotApptId);
    setCtxError(null);
    try {
      const res = await fetch(`/api/conversations/${c.id}/patient-appointments/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apricotApptId: a.apricotApptId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      setApptNote(`已取消 ${a.date} ${a.start} 預約（已發確認訊息）`);
      await refreshCtx();
      onBookingUiChanged?.();
    } catch (e) {
      setCtxError(e instanceof Error ? e.message : String(e));
    } finally {
      setApptBusy(null);
    }
  }

  // ★ H1：只有現任 assignee / ADMIN / unassigned（任何同店 STAFF 可 claim）先可以改負責人
  const canManage = !c.assigneeId || c.assigneeId === myStaffId || userRole === "ADMIN";

  // 共用內容（桌面側欄 + 手機 bottom sheet 各渲染一次；state 喺呢個 component 層，兩份同步）
  const content = (
    <div className="p-[18px] space-y-3">
      {/* contact 頂部：大 avatar 居中（Organic：62px brand 圓 + Caprasimo） */}
      <div className="flex flex-col items-center gap-1.5 pt-1">
        <div className="w-[62px] h-[62px] rounded-full bg-brand text-panel flex items-center justify-center font-display text-[26px]">
          {(c.contact?.profileName?.trim() || "?").charAt(0)}
        </div>
        <div className="font-display text-[18px] text-t1">
          {c.contact?.profileName || "未命名聯絡人"}
        </div>
        <div className="text-[11px] text-t3 font-mono">{c.contact?.waId ?? "—"}</div>
      </div>

      {/* contact 編輯（獨立卡） */}
      <div className="bg-panel-2 rounded-[22px] p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2 mb-2.5">聯絡人</div>
        <label className="block mb-2.5">
          <span className="text-[11px] text-t3">姓名（可編輯）</span>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            placeholder="未設姓名"
            className="mt-1 w-full text-sm rounded-full bg-panel border border-line px-3.5 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand"
          />
        </label>
        <div>
          <span className="text-[11px] text-t3">標籤</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {labels.map((l) => (
              <span
                key={l}
                className="inline-flex items-center gap-1 text-[11px] bg-brand-soft text-brand-text rounded-full pl-2 pr-1 py-0.5"
              >
                {l}
                <button
                  onClick={() => {
                    setLabels(labels.filter((x) => x !== l));
                    setDirty(true);
                  }}
                  aria-label={`移除標籤 ${l}`}
                  className="text-brand-text/60 hover:text-danger-text"
                >
                  <X size={11} strokeWidth={2.75} />
                </button>
              </span>
            ))}
          </div>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newLabel.trim()) {
                e.preventDefault();
                const l = newLabel.trim();
                if (!labels.includes(l)) {
                  setLabels([...labels, l]);
                  setDirty(true);
                }
                setNewLabel("");
              }
            }}
            placeholder="+ 標籤（Enter 確認）"
            className="mt-1.5 w-full text-xs rounded-full border border-dashed border-line-strong bg-transparent px-3.5 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand"
          />
        </div>
        {dirty && (
          <button
            onClick={() => void saveContact()}
            disabled={saving}
            className="mt-2.5 w-full text-xs px-3 py-1.5 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium disabled:opacity-50"
          >
            {saving ? "儲存中…" : "儲存聯絡人"}
          </button>
        )}
      </div>

      {/* ★ booking-ui（A）：病人 context — 獨立卡 + 18px 內卡（Organic） */}
      <div className="bg-panel-2 rounded-[22px] p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2 mb-2.5 inline-flex items-center gap-1.5">
          <CalendarClock size={12} strokeWidth={2.75} /> 病人 context
        </div>
        {ctxError && <div className="text-[10px] text-danger-text mb-1.5">⚠ {ctxError}</div>}
        {ctxLoading && !ctx && <div className="text-[11px] text-t3">載入中…</div>}
        {ctx && (
          <>
            {ctx.pinned ? (
              <div className="rounded-[18px] bg-panel border border-line p-3 text-xs space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[10px] text-t3">姓名（已釘住）</div>
                    <div className="text-t1 font-medium">{ctx.pinned.patientName ?? "—"}</div>
                  </div>
                  <button
                    onClick={() => void unpinPatient()}
                    disabled={pinBusy !== null}
                    className="text-[10px] text-t3 hover:text-danger-text disabled:opacity-50 shrink-0"
                  >
                    {pinBusy === "unpin" ? "取消中…" : "改釘/取消"}
                  </button>
                </div>
                <div>
                  <div className="text-[10px] text-t3">最近就診</div>
                  <div className="text-t2">
                    {ctx.pinned.lastVisit
                      ? `${ctx.pinned.lastVisit.date} · ${ctx.pinned.lastVisit.providerName}（${ctx.pinned.lastVisit.visitReasons.join("、")}）`
                      : "—（Apricot 無記錄）"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-t3">預約狀態</div>
                  <div className="text-t2">
                    {(ctx.upcomingAppointments ?? []).length > 0
                      ? `${ctx.upcomingAppointments!.length} 個 upcoming`
                      : "無 upcoming 預約"}
                  </div>
                </div>
              </div>
            ) : ctx.degraded || (ctx.matches && ctx.matches.length === 0) ? (
              <div className="rounded-[18px] bg-panel border border-line p-3 text-[11px] text-t3 space-y-1">
                <div>{ctx.degraded ? "⚠ 資料源離線（稍後重試）" : "查唔到匹配舊客（Apricot 無此電話記錄）"}</div>
                {!ctx.degraded && <div>新客請人手喺 Apricot 落單（第一期不支援代落單）</div>}
              </div>
            ) : (
              <div className="rounded-[18px] bg-panel border border-line p-3 text-xs space-y-2">
                <div className="text-[10px] text-t3">查到匹配舊客 — 撳〔釘住〕先可以用代落單</div>
                {(ctx.matches ?? []).map((m) => (
                  <div key={m.patientApricotId} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-t1 truncate">{m.patientName}</div>
                      <div className="text-[10px] text-t3 truncate">
                        {m.lastVisit ? `上次 ${m.lastVisit.date} · ${m.lastVisit.providerName}` : "無就診記錄"}
                      </div>
                    </div>
                    <button
                      onClick={() => void pinPatient(m)}
                      disabled={pinBusy !== null}
                      className="shrink-0 text-[11px] px-2.5 py-1 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium disabled:opacity-50"
                    >
                      {pinBusy === m.patientApricotId ? "釘住中…" : "釘住"}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* （E）upcoming 預約卡（status 0/102 only — API 已過濾）+ 兩新掣（Send Lock） */}
            {ctx.pinned && (ctx.upcomingAppointments ?? []).length > 0 && (
              <div className="mt-2 space-y-2">
                {apptNote && <div className="text-[10px] text-ok-text">✓ {apptNote}</div>}
                {[...(ctx.upcomingAppointments ?? [])]
                  .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`))
                  .map((a) => (
                    <div key={a.apricotApptId} className="rounded-[18px] border border-line bg-panel p-3 text-xs space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-t1 font-medium truncate">{a.providerName}</span>
                        <span
                          className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] ${
                            a.bookingStatus === 0 ? "bg-brand-soft text-brand-text" : "bg-warn-soft text-warn-text"
                          }`}
                        >
                          {a.bookingStatus === 0 ? "已確認" : "待確認"}
                        </span>
                      </div>
                      <div className="text-t2 font-mono">
                        {a.date} {a.start}–{a.end}
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => void startReschedule(a)}
                          disabled={!canManage || apptBusy !== null}
                          className="flex-1 text-[11px] px-2 py-1.5 rounded-full border border-line text-t1 hover:bg-panel-2 disabled:opacity-50"
                        >
                          {apptBusy === a.apricotApptId ? "處理中…" : "改期"}
                        </button>
                        <button
                          onClick={() => void cancelAppointment(a)}
                          disabled={!canManage || apptBusy !== null}
                          className={`flex-1 text-[11px] px-2 py-1.5 rounded-full border disabled:opacity-50 ${
                            confirmCancelId === a.apricotApptId
                              ? "border-danger-text bg-danger-soft text-danger-text font-semibold"
                              : "border-warn text-danger-text hover:bg-danger-soft"
                          }`}
                        >
                          {confirmCancelId === a.apricotApptId ? "再撳一次確認取消" : "取消預約"}
                        </button>
                      </div>
                    </div>
                  ))}
                {!canManage && (
                  <div className="text-[10px] text-warn-text">🔒 改期/取消只限現任負責人（{c.assigneeName}）</div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* AI 分析（Phase 2）— 獨立卡 */}
      <div className="bg-panel-2 rounded-[22px] p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2 mb-2.5 inline-flex items-center gap-1.5">
          <Sparkles size={12} strokeWidth={2.75} /> AI 分析
        </div>
        <div className="text-xs space-y-2">
          <div className="text-t2 leading-relaxed">{c.aiSummary ?? "—"}</div>
          <div className="flex gap-1.5 flex-wrap">
            <span className="px-2 py-0.5 rounded-full bg-brand-soft text-brand-text">
              {c.intent ? INTENT_LABEL[c.intent] ?? c.intent : "意圖 —"}
            </span>
            <span
              className={`px-2 py-0.5 rounded-full ${
                c.urgency ? URGENCY_META[c.urgency]?.cls ?? "bg-panel text-t2" : "bg-panel text-t3"
              }`}
            >
              {c.urgency ? URGENCY_META[c.urgency]?.label ?? c.urgency : "緊急度 —"}
            </span>
          </div>
          {c.urgent && (
            <button
              onClick={() => void onPatch({ urgent: false })}
              className="w-full text-xs px-2 py-1.5 rounded-full bg-danger hover:opacity-90 text-panel font-medium"
            >
              急症中 — 處理完後點擊清紅標
            </button>
          )}
        </div>
      </div>

      {/* status：segmented control（Organic 圓形分段） */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2 mb-2">狀態</div>
        <div className="flex bg-panel-2 rounded-full p-[3px] text-xs text-center">
          {STATUS_SEG.map((s) => (
            <button
              key={s.key}
              onClick={() => void setStatus(s.key)}
              className={`flex-1 py-1.5 rounded-full ${
                c.status === s.key
                  ? "bg-brand text-panel font-semibold shadow-sm"
                  : "text-t2 hover:bg-black/[.04]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* assignee */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2 mb-2">負責員工</div>
        <select
          value={c.assigneeId ?? ""}
          onChange={(e) => void onAssign(e.target.value || null)}
          disabled={!canManage || assignBusy}
          className="w-full text-sm rounded-full bg-panel-2 border border-line px-3.5 py-1.5 text-t1 focus:outline-none focus:border-brand disabled:opacity-50"
        >
          <option value="">（未分配 — 放返隊列）</option>
          {clinicStaff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.role === "ADMIN" ? "（管理員）" : ""}
            </option>
          ))}
        </select>
        {!canManage && (
          <div className="text-[10px] text-warn-text mt-1">
            🔒 只有現任負責人（{c.assigneeName}）或管理員可以改；喺對話欄撳〔接手〕先可以轉交畀自己
          </div>
        )}
        {assignError && <div className="text-[10px] text-danger-text mt-1">{assignError}</div>}
      </div>

      {/* Phase 4：今日當值（link 去 /schedule 七日週表頁）— brand-soft 強調卡 */}
      {duty && duty.entries.length > 0 && (
        <div className="bg-brand-soft rounded-[22px] p-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-text mb-2.5 inline-flex items-center gap-1.5">
            <Stethoscope size={12} strokeWidth={2.75} />
            當值（{duty.date}）
            <Link href="/schedule" className="ml-1 text-brand-text font-semibold normal-case tracking-normal hover:underline">
              睇成週 →
            </Link>
          </div>
          <div className="space-y-1.5">
            {duty.entries.map((e) => (
              <div key={`${e.staffName}-${e.shiftStart}`} className="flex items-center gap-2">
                <span className="w-[26px] h-[26px] rounded-full bg-panel text-brand-text flex items-center justify-center text-[11px] font-semibold shrink-0">
                  {(e.staffName?.trim() || "?").charAt(0)}
                </span>
                <span className="text-xs font-semibold text-t1 flex-1 truncate">
                  {e.staffName}
                  {e.role ? <span className="text-t2 font-normal ml-1">（{e.role}）</span> : null}
                </span>
                <span className="text-[10.5px] text-brand-text shrink-0 font-mono">
                  {e.shiftStart}–{e.shiftEnd}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* meta */}
      <div className="text-[11px] text-t3 space-y-1 pt-3 border-t border-line">
        <div>最後病人訊息：{c.lastInboundAt ? relTime(c.lastInboundAt) : "—"}</div>
        <div>最後訊息：{relTime(c.lastMessageAt)}</div>
      </div>
    </div>
  );

  return (
    <>
      {/* 桌面側欄（lg+，同 v2 一樣） */}
      <aside className="w-[302px] shrink-0 border-l border-line bg-panel hidden lg:flex flex-col min-h-0 overflow-y-auto">
        {content}
      </aside>

      {/* <lg：bottom sheet（absolute 相對 inbox-client relative 容器；z-40 < toast z-50） */}
      {mobileOpen && (
        <div className="lg:hidden absolute inset-0 z-40" role="dialog" aria-modal="true" aria-label="聯絡人詳情">
          <button
            aria-label="關閉詳情"
            onClick={onMobileClose}
            className="absolute inset-0 bg-black/40"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[85%] bg-panel rounded-t-2xl border-t border-line-strong shadow-2xl overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            <div className="sticky top-0 bg-panel pt-2 pb-1 flex justify-center" onClick={onMobileClose}>
              <div className="w-9 h-1 rounded-full bg-line-strong" />
            </div>
            {content}
          </div>
        </div>
      )}
    </>
  );
}
