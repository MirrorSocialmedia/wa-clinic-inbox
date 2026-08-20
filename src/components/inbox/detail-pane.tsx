"use client";

import { useEffect, useState } from "react";
import { Sparkles, Stethoscope, X } from "lucide-react";
import type { ConversationItem, ConvStatus, DutyInfo, StaffInfo } from "./types";
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
  LOW: { label: "緊急度 低", cls: "bg-panel-2 text-t2" },
  MED: { label: "緊急度 中", cls: "bg-warn-soft text-warn-text" },
  HIGH: { label: "緊急度 高", cls: "bg-danger-soft text-danger-text font-semibold" },
};

/**
 * 側欄（MD §6.4）v2 — SleekFlow 式 contact panel。
 * 功能同 v1 一樣：contact 編輯 / AI 分析 / 當值 / 狀態 / assignee / meta。
 */
export function DetailPane({ conversation, staff, onPatch, duty, myStaffId, userRole, onAssign, assignBusy, assignError }: Props) {
  const [name, setName] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (conversation?.contact) {
      setName(conversation.contact.profileName ?? "");
      setLabels(conversation.contact.labels ?? []);
      setNewLabel("");
      setDirty(false);
    }
  }, [conversation?.id, conversation?.contact?.profileName, conversation?.contact?.labels]);

  if (!conversation) {
    return (
      <aside className="w-72 shrink-0 border-l border-line bg-panel hidden lg:flex flex-col items-center justify-center text-t3 gap-2">
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

  // ★ H1：只有現任 assignee / ADMIN / unassigned（任何同店 STAFF 可 claim）先可以改負責人
  const canManage = !c.assigneeId || c.assigneeId === myStaffId || userRole === "ADMIN";

  return (
    <aside className="w-72 shrink-0 border-l border-line bg-panel hidden lg:flex flex-col min-h-0 overflow-y-auto">
      <div className="p-4 space-y-5">
        {/* contact 頂部：大 avatar 居中 */}
        <div className="flex flex-col items-center gap-1">
          <div className="w-14 h-14 rounded-full bg-brand-soft text-brand-text flex items-center justify-center text-lg font-medium">
            {(c.contact?.profileName?.trim() || "?").charAt(0)}
          </div>
          <div className="text-sm font-medium text-t1">
            {c.contact?.profileName || "未命名聯絡人"}
          </div>
          <div className="text-[11px] text-t3 font-mono">{c.contact?.waId ?? "—"}</div>
        </div>

        {/* contact 編輯 */}
        <div>
          <label className="block mb-2">
            <span className="text-[11px] text-t3">姓名（可編輯）</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
              placeholder="未設姓名"
              className="mt-1 w-full text-sm rounded-lg bg-panel-2 border border-transparent px-2.5 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand focus:bg-panel"
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
                    <X size={11} />
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
              placeholder="新增標籤，Enter 確認"
              className="mt-1.5 w-full text-xs rounded-lg bg-panel-2 border border-transparent px-2.5 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand focus:bg-panel"
            />
          </div>
          {dirty && (
            <button
              onClick={() => void saveContact()}
              disabled={saving}
              className="mt-2 w-full text-xs px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white font-medium disabled:opacity-50"
            >
              {saving ? "儲存中…" : "儲存聯絡人"}
            </button>
          )}
        </div>

        {/* AI 分析（Phase 2） */}
        <div>
          <h3 className="text-[11px] text-t3 font-semibold mb-2 inline-flex items-center gap-1">
            <Sparkles size={11} /> AI 分析
          </h3>
          <div className="rounded-xl bg-panel-2 p-3 text-xs space-y-2">
            <div className="text-t2 leading-relaxed">{c.aiSummary ?? "—"}</div>
            <div className="flex gap-1.5 flex-wrap">
              <span className="px-1.5 py-px rounded bg-ok-soft text-ok-text">
                {c.intent ? INTENT_LABEL[c.intent] ?? c.intent : "意圖 —"}
              </span>
              <span
                className={`px-1.5 py-px rounded ${
                  c.urgency ? URGENCY_META[c.urgency]?.cls ?? "bg-panel text-t2" : "bg-panel text-t3"
                }`}
              >
                {c.urgency ? URGENCY_META[c.urgency]?.label ?? c.urgency : "緊急度 —"}
              </span>
            </div>
            {c.urgent && (
              <button
                onClick={() => void onPatch({ urgent: false })}
                className="w-full text-xs px-2 py-1.5 rounded-lg bg-danger hover:opacity-90 text-white font-medium"
              >
                急症中 — 處理完後點擊清紅標
              </button>
            )}
          </div>
        </div>

        {/* status：segmented control */}
        <div>
          <h3 className="text-[11px] text-t3 font-semibold mb-2">狀態</h3>
          <div className="flex rounded-lg border border-line overflow-hidden text-xs text-center">
            {STATUS_SEG.map((s) => (
              <button
                key={s.key}
                onClick={() => void setStatus(s.key)}
                className={`flex-1 py-1.5 ${
                  c.status === s.key
                    ? "bg-brand text-white font-medium"
                    : "bg-panel text-t2 hover:bg-panel-2"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* assignee */}
        <div>
          <h3 className="text-[11px] text-t3 font-semibold mb-2">負責員工</h3>
          <select
            value={c.assigneeId ?? ""}
            onChange={(e) => void onAssign(e.target.value || null)}
            disabled={!canManage || assignBusy}
            className="w-full text-sm rounded-lg bg-panel-2 border border-transparent px-2.5 py-1.5 text-t1 focus:outline-none focus:border-brand focus:bg-panel disabled:opacity-50"
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

        {/* Phase 4：今日當值 */}
        {duty && duty.entries.length > 0 && (
          <div>
            <h3 className="text-[11px] text-t3 font-semibold mb-2 inline-flex items-center gap-1">
              <Stethoscope size={11} /> 今日當值（{duty.date}）
            </h3>
            <div className="rounded-xl bg-panel-2 p-3 text-xs space-y-1.5">
              {duty.entries.map((e) => (
                <div key={`${e.staffName}-${e.shiftStart}`} className="flex justify-between gap-2">
                  <span className="text-t1">
                    {e.staffName}
                    {e.role ? <span className="text-t3 ml-1">（{e.role}）</span> : null}
                  </span>
                  <span className="text-t2 font-mono">
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
    </aside>
  );
}
