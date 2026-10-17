"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MapPin, ChevronDown } from "lucide-react";
import type { ClinicLite, ConversationItem, StaffInfo } from "./types";

/**
 * ★ cwi-inbox-r3 Q5/Q6（2026-10-17）：地點膠囊 — 顯示對話「地點」（跟進分店 ?? 號碼店）；
 * 負責人 ∨ ADMIN 撳 → 轉地點對話框（同公司分店；原因；可選直接指派）。
 *
 * - list 版：列表 row 入面（row 本身係 <button> → 呢度用 span[role=button] + stopPropagation，
 *   對話框用 portal 掛 body — 唔會巢狀 interactive／唔會觸發 row 揀選）。
 * - header 版：對話頂部名旁邊（Q6 — 永遠顯示）。
 * - WhatsApp 號碼改唔到：轉咗之後顯示「跟進：MF」+ tooltip「經 TKW 號碼聯絡」。
 */

export interface LocationChange {
  conversationId: string;
  handlingClinicId: string | null;
  locationClinicId: string;
  locationCode: string;
  locationName: string;
  assigneeId: string | null;
  assignVersion: number;
}

export function LocationCapsule({
  conv,
  clinics,
  staff,
  canTransfer,
  variant,
  onChanged,
}: {
  conv: ConversationItem;
  clinics: ClinicLite[];
  staff: StaffInfo[];
  canTransfer: boolean;
  variant: "list" | "header";
  onChanged: (c: LocationChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const locId = conv.handlingClinicId ?? conv.clinicId;
  const loc = clinics.find((x) => x.id === locId);
  const channel = clinics.find((x) => x.id === conv.clinicId);
  const code = loc?.code ?? conv.locationCode ?? conv.clinicCode ?? "—";
  const moved = !!conv.handlingClinicId && conv.handlingClinicId !== conv.clinicId;
  const text = moved ? `跟進：${code}` : code;
  const title = moved
    ? `跟進分店：${loc?.name ?? code} · 經 ${channel?.code ?? conv.clinicCode ?? "原店"} 號碼聯絡`
    : `地點：${loc?.name ?? code}`;

  const cls =
    variant === "header"
      ? "text-[11px] px-2 py-0.5 rounded-full border border-brand/50 bg-brand-soft text-brand-text font-semibold inline-flex items-center gap-1 shrink-0"
      : "text-[10px] px-2 py-0.5 rounded-full bg-panel-2 text-t2 font-semibold inline-flex items-center gap-0.5";

  if (!canTransfer) {
    return (
      <span className={cls} title={title} data-testid={`loc-capsule-${variant}`}>
        {variant === "header" && <MapPin size={11} strokeWidth={2.5} />}
        {text}
      </span>
    );
  }
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        title={`${title} — 撳轉地點`}
        data-testid={`loc-capsule-${variant}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
        }}
        className={`${cls} cursor-pointer hover:ring-2 hover:ring-brand/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
      >
        {variant === "header" && <MapPin size={11} strokeWidth={2.5} />}
        {text}
        <ChevronDown size={10} strokeWidth={2.75} />
      </span>
      {open && (
        <TransferDialog conv={conv} clinics={clinics} staff={staff} onClose={() => setOpen(false)} onChanged={onChanged} />
      )}
    </>
  );
}

function TransferDialog({
  conv,
  clinics,
  staff,
  onClose,
  onChanged,
}: {
  conv: ConversationItem;
  clinics: ClinicLite[];
  staff: StaffInfo[];
  onClose: () => void;
  onChanged: (c: LocationChange) => void;
}) {
  const locId = conv.handlingClinicId ?? conv.clinicId;
  const channel = clinics.find((x) => x.id === conv.clinicId);
  // 同公司分店（SaaS 租戶隔離 — server 亦會擋跨公司）；channel 搵唔到（STAFF 冇全店清單）→ 列晒手上有嘅
  const options = useMemo(() => {
    const company = channel?.companyId;
    return clinics.filter((x) => (channel ? (x.companyId ?? null) === (company ?? null) : true));
  }, [clinics, channel]);
  const [target, setTarget] = useState<string>(() => options.find((x) => x.id !== locId)?.id ?? "");
  const [reason, setReason] = useState("");
  const [assignTo, setAssignTo] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const targetClinic = clinics.find((x) => x.id === target);
  const targetStaff = useMemo(() => staff.filter((s) => s.clinicId === target && s.role !== "SUPERVISOR"), [staff, target]);

  useEffect(() => {
    setAssignTo("");
  }, [target]);
  // 分店清單遲到（/api/clinics 未返）→ 到咗先補預設目標
  useEffect(() => {
    if (!target) {
      const first = options.find((x) => x.id !== locId);
      if (first) setTarget(first.id);
    }
  }, [options, target, locId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (!target || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/conversations/${conv.id}/location`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toClinicId: target,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(assignTo ? { assignToStaffId: assignTo } : {}),
        }),
      });
      const j = (await res.json().catch(() => null)) as (LocationChange & { error?: string }) | null;
      if (!res.ok || !j) {
        setErr(j?.error ?? `轉地點失敗（${res.status}）`);
        return;
      }
      onChanged({ ...j, conversationId: conv.id });
      onClose();
    } catch {
      setErr("轉地點失敗（網絡）");
    } finally {
      setBusy(false);
    }
  }

  const name = conv.contact?.profileName || "呢個病人";
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="轉地點"
      data-testid="loc-dialog"
    >
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-4 shadow-xl space-y-3 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold text-t1">轉地點：{name}</div>
        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
          {options.map((x) => (
            <label
              key={x.id}
              className={`flex items-center justify-between gap-2 rounded-xl px-3 py-1.5 border cursor-pointer ${
                target === x.id ? "border-brand bg-brand-soft text-brand-text" : "border-line text-t1 hover:bg-panel-2"
              } ${x.id === locId ? "opacity-60 cursor-not-allowed" : ""}`}
            >
              <span className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={`loc-${conv.id}`}
                  value={x.id}
                  checked={target === x.id}
                  disabled={x.id === locId}
                  onChange={() => setTarget(x.id)}
                />
                {x.code} · {x.name}
              </span>
              {x.id === locId && <span className="text-[11px] text-t3">目前</span>}
            </label>
          ))}
        </div>
        <div className="rounded-xl bg-panel-2 px-3 py-2 text-[12px] text-t2 space-y-0.5">
          <div>✔ {targetClinic?.code ?? "新分店"} 同事會喺列表見到，收通知</div>
          <div>✔ 預約、時間表預設用 {targetClinic?.code ?? "新分店"}</div>
          <div>✔ {assignTo ? "直接指派俾揀咗嘅同事" : "負責人清空，回到新分店公海"}</div>
          <div className="text-warn-text">✖ 病人仍然用 {channel?.code ?? conv.clinicCode ?? "原店"} 號碼同我哋傾（WhatsApp 號碼改唔到）</div>
        </div>
        <label className="block text-xs text-t2">
          原因（可選）
          <input
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例：病人住灣仔"
            className="mt-1 w-full rounded-full border border-line bg-panel px-3 py-1.5 text-sm text-t1"
          />
        </label>
        <label className="block text-xs text-t2">
          直接指派（可選）
          <select
            value={assignTo}
            onChange={(e) => setAssignTo(e.target.value)}
            className="mt-1 w-full rounded-full border border-line bg-panel px-3 py-1.5 text-sm text-t1"
          >
            <option value="">唔指派 — 放入 {targetClinic?.code ?? "新分店"} 公海</option>
            {targetStaff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {err && <div className="text-xs text-danger-text">{err}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-full border border-line px-3 py-1.5 text-sm text-t2 hover:bg-panel-2">
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!target || target === locId || busy}
            className="rounded-full bg-brand px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40"
            data-testid="loc-submit"
          >
            {busy ? "轉緊…" : `轉去 ${targetClinic?.code ?? ""}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
