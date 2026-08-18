"use client";

import { useEffect, useState } from "react";
import type { ConversationItem, ConvStatus, StaffInfo } from "./types";
import { relTime } from "./time";

interface Props {
  conversation: ConversationItem | null;
  staff: StaffInfo[];
  onPatch: (body: { status?: ConvStatus; assigneeId?: string | null }) => Promise<void>;
}

const STATUS_META: Record<ConvStatus, { label: string; cls: string }> = {
  OPEN: { label: "OPEN（處理中）", cls: "bg-sky-600 text-white" },
  PENDING: { label: "PENDING（等病人）", cls: "bg-amber-500 text-white" },
  RESOLVED: { label: "RESOLVED（已解決）", cls: "bg-neutral-500 text-white" },
};

/**
 * 側欄（MD §6.4）：
 * - Contact 資料：waId / profileName（可編輯）/ labels（可編輯）
 * - assignee 選擇（自己店 staff）
 * - 狀態轉換 OPEN ↔ PENDING ↔ RESOLVED
 */
export function DetailPane({ conversation, staff, onPatch }: Props) {
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
      <aside className="w-72 shrink-0 border-l border-neutral-200 bg-white hidden lg:flex flex-col items-center justify-center text-neutral-300">
        <div className="text-3xl">👤</div>
        <div className="text-xs mt-2">揀一個對話先見到聯絡人資料</div>
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

  async function setAssignee(id: string) {
    await onPatch({ assigneeId: id || null });
  }

  return (
    <aside className="w-72 shrink-0 border-l border-neutral-200 bg-white hidden lg:flex flex-col min-h-0 overflow-y-auto">
      <div className="p-4 space-y-4">
        {/* contact */}
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-neutral-400 font-semibold mb-2">聯絡人</h3>
          <div className="text-xs text-neutral-500 mb-2">
            <span className="text-neutral-400">WhatsApp：</span>
            <span className="font-mono text-neutral-700">{c.contact?.waId ?? "—"}</span>
          </div>
          <label className="block mb-2">
            <span className="text-xs text-neutral-500">姓名（可編輯）</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
              placeholder="未設姓名"
              className="mt-1 w-full text-sm rounded border border-neutral-200 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
          </label>
          <div>
            <span className="text-xs text-neutral-500">標籤</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {labels.map((l) => (
                <span key={l} className="inline-flex items-center gap-1 text-[11px] bg-neutral-100 text-neutral-700 rounded-full pl-2 pr-1 py-0.5">
                  {l}
                  <button
                    onClick={() => {
                      setLabels(labels.filter((x) => x !== l));
                      setDirty(true);
                    }}
                    className="text-neutral-400 hover:text-red-500"
                  >
                    ✕
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
              className="mt-1.5 w-full text-xs rounded border border-neutral-200 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
          </div>
          {dirty && (
            <button
              onClick={() => void saveContact()}
              disabled={saving}
              className="mt-2 text-xs px-3 py-1.5 rounded bg-neutral-900 text-white disabled:opacity-50"
            >
              {saving ? "儲存中…" : "儲存聯絡人"}
            </button>
          )}
        </div>

        {/* status */}
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-neutral-400 font-semibold mb-2">狀態</h3>
          <div className="space-y-1">
            {(Object.keys(STATUS_META) as ConvStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => void setStatus(s)}
                className={`w-full text-left text-xs px-2.5 py-1.5 rounded border ${
                  c.status === s
                    ? STATUS_META[s].cls
                    : "bg-white text-neutral-600 border-neutral-200 hover:bg-neutral-50"
                }`}
              >
                {STATUS_META[s].label}
              </button>
            ))}
          </div>
        </div>

        {/* assignee */}
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-neutral-400 font-semibold mb-2">負責員工</h3>
          <select
            value={c.assigneeId ?? ""}
            onChange={(e) => void setAssignee(e.target.value)}
            className="w-full text-sm rounded border border-neutral-200 px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-sky-400"
          >
            <option value="">（未分配）</option>
            {clinicStaff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.role === "ADMIN" ? "（管理員）" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* meta */}
        <div className="text-[11px] text-neutral-400 space-y-1 pt-2 border-t border-neutral-100">
          <div>最後病人訊息：{c.lastInboundAt ? relTime(c.lastInboundAt) : "—"}</div>
          <div>最後訊息：{relTime(c.lastMessageAt)}</div>
        </div>
      </div>
    </aside>
  );
}
