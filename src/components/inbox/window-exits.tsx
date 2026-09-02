"use client";

/**
 * 過窗三出路（cwi-window-20260901 P3 / W-1 抽離 — cwi-schedv2-20260903 D.3 共用）
 *
 * 原本係 chat-pane composer 內聯；D.3「過窗改出三出路」要求排班板 popover / 側欄
 * 迷你表喺目標對話過窗時出同一組出路 → 抽做共享組件。markup 與原 chat-pane 版本
 * 逐字一致（T171–T174 e2e 斷言兼容）。
 *
 * 三出路（MD C.2 §1）：
 *   ① 開手機 App 免費覆（wa.me — 撳掣落 audit + INTERNAL 備註）
 *   ② 發 template（APPROVED+UTILITY 名單 picker — 逐條收費）
 *   ③ 等病人下次搵你（窗口會重開）
 */
import { useEffect, useState } from "react";
import { Clock, MessageCircle } from "lucide-react";
import type { ConversationItem } from "./types";

interface Props {
  conversation: ConversationItem;
  /** ★ H1：自己 staffId（lock 判定 — 被人負責嘅對話唔拉 template picker，同 chat-pane 一致） */
  myStaffId: string;
  /** AI 草稿文字 — ① wa.me ?text= 帶埋（chat-pane P3 語義） */
  draftText?: string | null;
  /** template 發送成功後（parent 重拉對話/側欄） */
  onTemplateSent?: () => void;
  /** 發送/記錄失敗（parent 顯示 error — chat-pane 用 sendError） */
  onError?: (msg: string) => void;
}

export function WindowExits({ conversation: c, myStaffId, draftText, onTemplateSent, onError }: Props) {
  // ② template picker（GET /templates）— 過窗 + 未 lock 先拉（同 chat-pane P3 gate 一致）
  const [picker, setPicker] = useState<{
    templates: { name: string; language: string; category: string; supported: boolean; preview: string | null }[];
    prefill: { patientName: string | null; clinicName: string; requestedDate: string; requestedTime: string; providerName: string } | null;
  } | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerSel, setPickerSel] = useState("");
  const [pickerBusy, setPickerBusy] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);

  const winOpen = c.window?.open;
  const locked = !!c.assigneeId && c.assigneeId !== myStaffId;

  useEffect(() => {
    let alive = true;
    setPicker(null);
    setPickerSel("");
    if (!c.id || winOpen || locked) return;
    setPickerLoading(true);
    fetch(`/api/conversations/${c.id}/templates`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && Array.isArray(d.templates)) {
          setPicker(d);
          const firstSupported = d.templates.find((t: { supported: boolean }) => t.supported);
          if (d.templates.length > 0) setPickerSel(firstSupported?.name ?? d.templates[0].name);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setPickerLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [c.id, winOpen, locked]);

  /** ② 發 template — 同 inbox-client sendTemplate 同一 endpoint（R1 冪等：一次意圖一個 UUID） */
  async function sendTemplate(name: string) {
    if (!name || pickerBusy) return;
    setPickerBusy(true);
    onError?.(" ");
    try {
      const clientMessageId = crypto.randomUUID();
      const res = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: c.id, templateName: name, clientMessageId }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!res.ok) {
        onError?.(data?.message ?? data?.error ?? `template 發送失敗（${res.status}）`);
      } else {
        onTemplateSent?.();
      }
    } catch {
      onError?.("template 發送失敗（網絡錯誤）");
    }
    setPickerBusy(false);
  }

  // ① 開手機對話 — 撳 <a href=wa.me> 時落 audit + INTERNAL 備註（唔阻 navigation）。
  // link 由 <a> 本身帶（E164 無加號 + encodeURIComponent 草稿 — server 唔經手電話）。
  async function appHandoffAudit() {
    if (handoffBusy) return;
    setHandoffBusy(true);
    try {
      const res = await fetch(`/api/conversations/${c.id}/app-handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) onError?.("App handoff 記錄失敗（HTTP " + res.status + "）");
    } catch {
      onError?.("App handoff 記錄失敗（網絡錯誤）");
    }
    setHandoffBusy(false);
  }

  const digits = (c.contact?.waId ?? "").replace(/[^0-9]/g, "");
  const waUrl = digits
    ? `https://wa.me/${digits}${draftText ? `?text=${encodeURIComponent(draftText)}` : ""}`
    : null;

  return (
    <div className="rounded-2xl border border-line bg-panel p-3 flex flex-col gap-2.5">
      <div className="text-xs font-semibold text-t1 flex items-center gap-1.5">
        <Clock size={13} strokeWidth={2.5} className="text-warn-text" />
        24 小時窗口已過 — 揀一個方式跟進
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-[11.5px] font-medium text-t1">① 用手機 WhatsApp 覆（免費 · 建議）</div>
        <div className="flex items-center gap-2 flex-wrap">
          {waUrl ? (
            <a
              href={waUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => void appHandoffAudit()}
              className="text-xs px-3 py-1.5 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium inline-flex items-center gap-1"
            >
              <MessageCircle size={12} strokeWidth={2.5} /> 開手機對話
            </a>
          ) : (
            <span className="text-[10.5px] text-t3">冇有效 WhatsApp 號碼 — 開唔到手機對話</span>
          )}
          <span className="text-[10px] text-t3">只適用於主動搵過我哋嘅病人 · 覆完會自動同步返呢度</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-[11.5px] font-medium text-t1">② 發 template（要審批 · 逐條收費）</div>
        {pickerLoading ? (
          <div className="text-[10.5px] text-t3">載入 template 名單…</div>
        ) : picker && picker.templates.length > 0 ? (
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={pickerSel}
              onChange={(e) => setPickerSel(e.target.value)}
              aria-label="揀 template"
              className="text-xs px-2 py-1.5 rounded-full bg-panel-2 border border-line-strong text-t1"
            >
              {picker.templates.map((t) => (
                <option key={t.name} value={t.name} disabled={!t.supported}>
                  {t.name}（{t.language}）{t.supported ? "" : " · v1 未支援"}
                </option>
              ))}
            </select>
            <button
              onClick={() => void sendTemplate(pickerSel)}
              disabled={pickerBusy || !pickerSel}
              className="text-xs px-3 py-1.5 rounded-full bg-warn hover:opacity-90 text-warn-text font-medium disabled:opacity-40"
            >
              發送（逐條收費）
            </button>
            <span className="w-full text-[10px] text-t3">
              {picker.prefill
                ? `變數已填好：${picker.prefill.patientName ?? "病人"} · ${picker.prefill.requestedDate} ${picker.prefill.requestedTime} · ${picker.prefill.providerName} · ${picker.prefill.clinicName}`
                : "冇 CONFIRMED 預約 — 呢款 template 需要日期/時間/醫生（落單確認後重試）"}
            </span>
          </div>
        ) : (
          <div className="text-[10.5px] text-t3">冇可用 APPROVED template（或名單載入失敗）</div>
        )}
      </div>
      <div className="text-[11.5px] font-medium text-t1">③ 等病人下次搵你（窗口會重開）</div>
    </div>
  );
}
