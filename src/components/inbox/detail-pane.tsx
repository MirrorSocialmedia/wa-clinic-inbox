"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, CheckCheck, ChevronLeft, ChevronRight, Lock, Sparkles, Tag, X } from "lucide-react";
import type { ClinicLite, ConversationItem, ConvStatus, PatientAppointment, PatientContext, PatientMatch, StaffInfo } from "./types";
import { relTime } from "./time";
import { MiniSchedule } from "./mini-schedule";

interface Props {
  conversation: ConversationItem | null;
  staff: StaffInfo[];
  onPatch: (body: { status?: ConvStatus; assigneeId?: string | null; urgent?: boolean }) => Promise<void>;
  /** ★ H1：自己 staffId + 角色 — 判定 canManage（現任 assignee / ADMIN / unassigned 任何 STAFF） */
  myStaffId: string;
  /** D.4（cwi-schedv2-20260903）：本對話嘅 clinic code（MiniSchedule 拉 /api/flows/slots 用；null → 隱藏表） */
  clinicCode?: string | null;
  userRole: "ADMIN" | "STAFF";
  /** ★ H1：轉交/派單/放返隊列 — POST /api/conversations/[id]/assign（INTERNAL note + AuditLog + socket） */
  onAssign: (toStaffId: string | null) => Promise<{ ok: boolean; error?: string }>;
  assignBusy: boolean;
  assignError: string | null;
  /** cwi-multiclinic-20260903（MD A.6.2）：全店 active staff（二級選單「其他分店…」店→員工用） */
  allStaff?: StaffInfo[];
  /** cwi-multiclinic-20260903：全診所清單（店→員工分組 + 店名） */
  allClinics?: ClinicLite[];
  /** <lg：bottom sheet 開關（由 inbox-client 控制；桌面側欄常駐不受影響） */
  mobileOpen: boolean;
  onMobileClose: () => void;
  /** ★ booking-ui：patient-context 寫入（釘住/改期/取消）後通知 parent 重拉（對話卡/預約卡）— 同 socket booking:changed 雙保險 */
  onBookingUiChanged?: () => void;
  /** ★ booking-ui（C）：socket booking:changed / parent 重拉觸發 patient-context 重載 */
  ctxRefreshKey?: number;
  /** ★ cwi-h6 §4：socket note:new / 備註寫入後 parent 重拉訊號（內部備註卡） */
  notesRefreshKey?: number;
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
  myStaffId,
  clinicCode,
  userRole,
  onAssign,
  assignBusy,
  assignError,
  allStaff = [],
  allClinics = [],
  mobileOpen,
  onMobileClose,
  onBookingUiChanged,
  ctxRefreshKey = 0,
  notesRefreshKey = 0,
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

  // ★ cwi-h6 §4：內部備註卡 — reuse GET messages（channel=INTERNAL type=note）+ note-read-receipts（無新 API）
  const [notes, setNotes] = useState<{ id: string; body: string; sentByStaffId: string | null; waTimestamp: string | null }[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteReceipts, setNoteReceipts] = useState<{ messageId: string; staffId: string; readAt: string }[]>([]);
  // 聯絡人卡：標籤圖標按鈕展開狀態（§4 壓一格）
  const [showLabelEditor, setShowLabelEditor] = useState(false);

  const loadNotes = useCallback(async (convId: string) => {
    try {
      setNotesLoading(true);
      const [mRes, rRes] = await Promise.all([
        fetch(`/api/conversations/${convId}/messages?limit=100`),
        fetch(`/api/conversations/${convId}/note-read-receipts`),
      ]);
      if (mRes.ok) {
        const mj = (await mRes.json()) as {
          messages?: { id: string; body: string | null; sentByStaffId: string | null; waTimestamp: string | null; channel?: string; type?: string }[];
        };
        const internal = (mj.messages ?? [])
          .filter((m) => m.channel === "INTERNAL" && m.type === "note")
          .sort((a, b) => new Date(b.waTimestamp ?? 0).getTime() - new Date(a.waTimestamp ?? 0).getTime());
        setNotes(internal.map((m) => ({ id: m.id, body: m.body ?? "", sentByStaffId: m.sentByStaffId, waTimestamp: m.waTimestamp })));
      }
      if (rRes.ok) {
        const rj = (await rRes.json()) as { receipts?: { messageId: string; staffId: string; readAt: string }[] };
        setNoteReceipts(rj.receipts ?? []);
      }
    } catch {
      /* fail-soft：備註卡只係空，唔阻側欄其餘部分 */
    } finally {
      setNotesLoading(false);
    }
  }, []);

  // 對話切換 → reset + 拉備註；notesRefreshKey = socket note:new 訊號（parent 重拉）
  useEffect(() => {
    setNotes([]);
    setNotesExpanded(false);
    setNoteDraft("");
    setNoteReceipts([]);
    setShowLabelEditor(false);
    if (!conversation?.id) return;
    void loadNotes(conversation.id);
  }, [conversation?.id, loadNotes]);

  useEffect(() => {
    if (conversation?.id && notesRefreshKey > 0) void loadNotes(conversation.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesRefreshKey]);

  async function addNote() {
    const conv = conversation;
    if (!conv || noteBusy || !noteDraft.trim()) return;
    setNoteBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conv.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: noteDraft.trim() }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      setNoteDraft("");
      await loadNotes(conv.id);
    } catch {
      /* fail-soft：保留 draft 俾用戶重試 */
    } finally {
      setNoteBusy(false);
    }
  }

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

  // ── cwi-multiclinic-20260903（MD A.6.2）：指派選單二級（本店 + 「其他分店…」店→員工）──
  //   view: main = L1（本店 staff + 其他分店…）/ clinics = L2（分店列表）/ staff = L3（該店 staff）
  //   跨店（L3 揀人）→ confirm「對方將可查閱呢個對話嘅完整記錄」先真 assign（server 權限守）。
  //   ★ hooks 必須喺 `if (!conversation)` early-return 之前（React rules of hooks — 條件 hooks 會破 hydration）。
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [assignView, setAssignView] = useState<"main" | "clinics" | "staff">("main");
  const [assignSubClinicId, setAssignSubClinicId] = useState<string | null>(null);
  const [assignCrossPending, setAssignCrossPending] = useState<StaffInfo | null>(null);
  useEffect(() => {
    setAssignMenuOpen(false);
    setAssignView("main");
    setAssignSubClinicId(null);
    setAssignCrossPending(null);
  }, [conversation?.id]);

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

  const otherClinics = allClinics.filter((cl) => cl.id !== c.clinicId);
  const clinicLabel = (id: string | null): string => {
    const cl = allClinics.find((x) => x.id === id);
    return cl ? `${cl.code} ${cl.name}` : "";
  };
  const staffOfClinic = (cid: string): StaffInfo[] => allStaff.filter((s) => s.clinicId === cid || !s.clinicId);
  const closeAssignMenu = () => {
    setAssignMenuOpen(false);
    setAssignView("main");
    setAssignSubClinicId(null);
    setAssignCrossPending(null);
  };
  const doAssign = (toStaffId: string | null) => {
    closeAssignMenu();
    void onAssign(toStaffId);
  };

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
      {/* ★ cwi-h6 §4：聯絡人卡壓一格（32px avatar + 姓名 input flex-1 同一行 + 標籤圖標按鈕展開；padding 10px 12px） */}
      <div className="bg-panel-2 rounded-[16px] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand text-panel flex items-center justify-center font-display text-sm shrink-0">
            {(name.trim() || c.contact?.profileName || "?").charAt(0)}
          </div>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            placeholder="姓名（撳入編輯）"
            aria-label="聯絡人姓名"
            className="flex-1 min-w-0 bg-transparent text-sm text-t1 placeholder:text-t3 focus:outline-none"
          />
          <button
            onClick={() => setShowLabelEditor((v) => !v)}
            aria-label="編輯標籤"
            title="標籤"
            className={`shrink-0 w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${showLabelEditor || labels.length > 0 ? "border-brand text-brand" : "border-line text-t3 hover:text-brand"}`}
          >
            <Tag size={13} strokeWidth={2.5} />
          </button>
        </div>
        {showLabelEditor && (
          <div className="mt-2 pl-10">
            <div className="flex flex-wrap gap-1">
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
              className="mt-1.5 w-full text-xs rounded-full border border-dashed border-line-strong bg-transparent px-3 py-1 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand"
            />
          </div>
        )}
        {dirty && (
          <button
            onClick={() => void saveContact()}
            disabled={saving}
            className="mt-2 ml-10 text-[11px] px-2.5 py-1 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium disabled:opacity-50"
          >
            {saving ? "儲存中…" : "儲存"}
          </button>
        )}
      </div>

      {/* ★ cwi-h6 §4：內部備註卡（staff-only，唔入 AI；5 條 + 展開全部 + 已讀 receipt；realtime = note:new → parent 重拉） */}
      <div className="bg-panel-2 rounded-[16px] p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2 inline-flex items-center gap-1.5">
            <Lock size={11} strokeWidth={2.75} /> 內部備註
          </div>
          <div className="text-[10px] text-t3">staff 獨見 · 唔入 AI</div>
        </div>
        {notesLoading && notes.length === 0 && <div className="mt-2 text-[11px] text-t3">載入中…</div>}
        {!notesLoading && notes.length === 0 && <div className="mt-2 text-[11px] text-t3">未有備註</div>}
        <div className="mt-2 space-y-1.5">
          {(notesExpanded ? notes : notes.slice(0, 5)).map((n) => {
            const readCount = noteReceipts.filter((r) => r.messageId === n.id).length;
            return (
              <div key={n.id} className="rounded-[12px] bg-panel border border-line px-2.5 py-1.5">
                <div className="flex items-center gap-1.5 text-[10px] text-t3">
                  <span className="text-t2 font-medium">{staff.find((s) => s.id === n.sentByStaffId)?.name ?? "Staff"}</span>
                  <span>{relTime(n.waTimestamp)}</span>
                  {readCount > 0 && (
                    <span className="text-brand inline-flex items-center gap-0.5">
                      <CheckCheck size={10} strokeWidth={2.5} /> 已讀 {readCount}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-t1 whitespace-pre-wrap break-words">{n.body}</div>
              </div>
            );
          })}
        </div>
        {notes.length > 5 && (
          <button onClick={() => setNotesExpanded((v) => !v)} className="mt-1.5 text-[11px] text-brand hover:underline">
            {notesExpanded ? "收起" : `展開全部（${notes.length}）`}
          </button>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && noteDraft.trim()) void addNote();
            }}
            placeholder="加備註…"
            aria-label="新增內部備註"
            className="flex-1 min-w-0 text-xs rounded-full bg-panel border border-line px-3 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand"
          />
          <button
            onClick={() => void addNote()}
            disabled={noteBusy || !noteDraft.trim()}
            className="shrink-0 text-xs px-2.5 py-1.5 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium disabled:opacity-50"
          >
            加
          </button>
        </div>
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

      {/* assignee — cwi-multiclinic-20260903（MD A.6.2）：二級選單（本店 + 其他分店…店→員工） */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2 mb-2">負責員工</div>
        <div className="relative">
          <button
            type="button"
            data-e2e="assign-trigger"
            onClick={() => {
              setAssignMenuOpen(!assignMenuOpen);
              setAssignView("main");
              setAssignSubClinicId(null);
            }}
            disabled={!canManage || assignBusy}
            className="w-full text-sm rounded-full bg-panel-2 border border-line px-3.5 py-1.5 text-t1 text-left focus:outline-none focus:border-brand disabled:opacity-50"
          >
            {c.assigneeId ? (c.assigneeName ?? "—") : "（未分配 — 放返隊列）"}
          </button>
          {/* 跨店 confirm（MD A.6.2 文案）— 揀咗其他分店嘅人先出 */}
          {assignCrossPending ? (
            <div data-e2e="assign-cross-confirm" className="absolute z-20 mt-1 w-full bg-panel border border-line rounded-2xl shadow-lg p-3">
              <p className="text-xs text-t1 mb-1">
                指派俾 <b>{assignCrossPending.name}</b>
                {assignSubClinicId ? `（${clinicLabel(assignSubClinicId)}）` : ""}
              </p>
              <p className="text-[11px] text-warn-text mb-2.5">對方將可查閱呢個對話嘅完整記錄</p>
              <div className="flex gap-2">
                <button
                  onClick={() => doAssign(assignCrossPending.id)}
                  disabled={assignBusy}
                  className="flex-1 py-1.5 rounded-full bg-brand text-panel text-xs font-medium hover:opacity-90 disabled:opacity-50"
                >
                  確認指派
                </button>
                <button
                  onClick={() => setAssignCrossPending(null)}
                  className="flex-1 py-1.5 rounded-full bg-panel-2 border border-line text-t2 text-xs hover:text-t1 disabled:opacity-50"
                >
                  取消
                </button>
              </div>
            </div>
          ) : assignMenuOpen ? (
            <>
              <div className="fixed inset-0 z-10" onClick={closeAssignMenu} />
              <div data-e2e="assign-menu" className="absolute z-20 mt-1 w-full bg-panel border border-line rounded-2xl shadow-lg py-1 max-h-80 overflow-y-auto">
                <button
                  onClick={() => doAssign(null)}
                  disabled={assignBusy}
                  className="w-full text-left px-3.5 py-1.5 text-sm text-t1 hover:bg-panel-2 disabled:opacity-50"
                >
                  （未分配 — 放返隊列）
                </button>
                {assignView === "main" && (
                  <>
                    <div className="px-3.5 pt-2 pb-0.5 text-[10px] text-t3">本店（{clinicLabel(c.clinicId) || "本診所"}）</div>
                    {clinicStaff.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => doAssign(s.id)}
                        disabled={assignBusy}
                        className="w-full text-left px-3.5 py-1.5 text-sm text-t1 hover:bg-panel-2 flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <span className="truncate">{s.name}</span>
                        {s.role === "ADMIN" && <span className="ml-auto text-[10px] text-t3 shrink-0">管理員</span>}
                        {c.assigneeId === s.id && <span className="ml-auto text-[10px] text-brand-text shrink-0">現任</span>}
                      </button>
                    ))}
                    {otherClinics.length > 0 && (
                      <button
                        onClick={() => {
                          setAssignView("clinics");
                          setAssignSubClinicId(null);
                        }}
                        className="w-full text-left px-3.5 py-1.5 text-sm text-brand-text hover:bg-panel-2 flex items-center gap-1"
                      >
                        其他分店… <ChevronRight size={13} strokeWidth={2.75} />
                      </button>
                    )}
                  </>
                )}
                {assignView === "clinics" && (
                  <>
                    <button
                      onClick={() => setAssignView("main")}
                      className="w-full text-left px-3.5 py-1.5 text-sm text-t2 hover:bg-panel-2 flex items-center gap-1"
                    >
                      <ChevronLeft size={13} strokeWidth={2.75} /> 返回
                    </button>
                    {otherClinics.map((cl) => (
                      <button
                        key={cl.id}
                        onClick={() => {
                          setAssignSubClinicId(cl.id);
                          setAssignView("staff");
                        }}
                        className="w-full text-left px-3.5 py-1.5 text-sm text-t1 hover:bg-panel-2 flex items-center gap-1.5"
                      >
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-panel-2 text-t2 font-semibold shrink-0">{cl.code}</span>
                        <span className="truncate">{cl.name}</span>
                        <ChevronRight size={13} strokeWidth={2.75} className="ml-auto text-t3 shrink-0" />
                      </button>
                    ))}
                  </>
                )}
                {assignView === "staff" && assignSubClinicId && (
                  <>
                    <button
                      onClick={() => setAssignView("clinics")}
                      className="w-full text-left px-3.5 py-1.5 text-sm text-t2 hover:bg-panel-2 flex items-center gap-1"
                    >
                      <ChevronLeft size={13} strokeWidth={2.75} /> 返回
                    </button>
                    <div className="px-3.5 pt-2 pb-0.5 text-[10px] text-t3">{clinicLabel(assignSubClinicId)}</div>
                    {staffOfClinic(assignSubClinicId).map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          // 跨店 — 先 confirm（MD A.6.2）
                          setAssignCrossPending(s);
                        }}
                        className="w-full text-left px-3.5 py-1.5 text-sm text-t1 hover:bg-panel-2 flex items-center gap-1.5"
                      >
                        <span className="truncate">{s.name}</span>
                        {s.role === "ADMIN" && <span className="ml-auto text-[10px] text-t3 shrink-0">管理員</span>}
                      </button>
                    ))}
                    {staffOfClinic(assignSubClinicId).length === 0 && (
                      <div className="px-3.5 py-1.5 text-xs text-t3">該店暫無可指派嘅 staff</div>
                    )}
                  </>
                )}
              </div>
            </>
          ) : null}
        </div>
        {!canManage && (
          <div className="text-[10px] text-warn-text mt-1">
            🔒 只有現任負責人（{c.assigneeName}）或管理員可以改；喺對話欄撳〔接手〕先可以轉交畀自己
          </div>
        )}
        {assignError && <div className="text-[10px] text-danger-text mt-1">{assignError}</div>}
      </div>

      {/* D.4（cwi-schedv2-20260903）：今日可約迷你表（取代舊「當值卡」— 當值降底行；撳格 = 幫病人約） */}
      <MiniSchedule
        conversation={c}
        myStaffId={myStaffId}
        clinicCode={clinicCode ?? null}
        onFlowSent={onBookingUiChanged}
      />

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
