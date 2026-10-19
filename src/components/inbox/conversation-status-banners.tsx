"use client";

/**
 * ★ 擁有人 2026-10-18：對話欄頂部狀態橫額（唔使開右邊「病人記錄」都見到）
 *
 * - 🙋 病人要求真人跟進（琥珀）— AI 自動回覆已暫停；「交返 AI 繼續」= 同右欄同一個 PATCH
 * - 🔕 病人已退訂（灰）— 系統主動訊息全擋；員工手動回覆照常；「恢復跟進」要記錄病人同意（同右欄 prompt 口徑）
 *
 * 資料：GET /api/conversations/:id/patient-requested-human（輕量 — 唔打 workforce）。
 * 刷新時機：換對話／收到新病人訊息（即刻 + 4s + 10s — AI pipeline 設旗有延遲）／右欄改咗狀態（window 事件）。
 * SUPERVISOR（canWrite=false）只顯示，唔出掣。
 */
import { useCallback, useEffect, useState } from "react";

export const CONV_FLAGS_EVENT = "wa:conv-flags-changed";

type Flags = {
  humanRequest: { active: boolean; at: string | null };
  optOut: { active: boolean; at: string | null; contactId: string | null };
  canWrite: boolean;
};

const hhmm = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";

export function ConversationStatusBanners({
  conversationId,
  lastInboundId,
  compact,
}: {
  conversationId: string;
  lastInboundId: string | null;
  compact: boolean;
}) {
  const [flags, setFlags] = useState<Flags | null>(null);
  const [busy, setBusy] = useState<"human" | "optout" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/patient-requested-human`);
      if (!res.ok) return;
      setFlags((await res.json()) as Flags);
    } catch {
      /* 網絡錯 — 保留上次狀態 */
    }
  }, [conversationId]);

  useEffect(() => {
    setFlags(null);
  }, [conversationId]);

  useEffect(() => {
    void load();
    const t1 = setTimeout(() => void load(), 4000);
    const t2 = setTimeout(() => void load(), 10000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [load, lastInboundId]);

  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (!id || id === conversationId) void load();
    };
    window.addEventListener(CONV_FLAGS_EVENT, on);
    return () => window.removeEventListener(CONV_FLAGS_EVENT, on);
  }, [conversationId, load]);

  const changed = () => window.dispatchEvent(new CustomEvent(CONV_FLAGS_EVENT, { detail: { conversationId } }));

  async function handBack() {
    if (busy) return;
    setBusy("human");
    try {
      const res = await fetch(`/api/conversations/${conversationId}/patient-requested-human`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      changed();
    } catch (e) {
      alert(`交返 AI 失敗，請稍後再試（${e instanceof Error ? e.message : ""}）`);
    } finally {
      setBusy(null);
    }
  }

  async function resumeFollowup() {
    const contactId = flags?.optOut.contactId;
    if (busy || !contactId) return;
    // 同右欄口徑：重新啟用必須記錄病人同意（來源/時間/用途）
    const purpose = window
      .prompt("重新啟用主動跟進需要記錄病人同意（合規要求）。\n請填寫：病人何時/點同意再收跟進？（例：10/15 WhatsApp 回覆「可以繼續發」）")
      ?.trim();
    if (purpose === undefined) return;
    if (!purpose) {
      alert("請填寫病人同意嘅來源/用途，否則唔可以重新啟用。");
      return;
    }
    setBusy("optout");
    try {
      const res = await fetch(`/api/followups/contacts/${contactId}/opt-out`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optOut: false, consent: { purpose } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      changed();
    } catch (e) {
      alert(`跟進通知更新失敗，請稍後再試（${e instanceof Error ? e.message : ""}）`);
    } finally {
      setBusy(null);
    }
  }

  if (!flags || (!flags.humanRequest.active && !flags.optOut.active)) return null;

  const btn = "shrink-0 text-[11.5px] px-2.5 py-0.5 rounded-full border border-current bg-panel hover:opacity-80 disabled:opacity-50";
  return (
    <div className="shrink-0 flex flex-col gap-1.5 px-3 md:px-4 py-2 bg-panel border-b border-line" data-e2e="conv-status-banners">
      {flags.humanRequest.active && (
        <div
          className="flex items-center gap-2 rounded-xl px-3 py-1.5 text-[12.5px] bg-warn-soft text-warn-text border border-warn/40"
          role="status"
          data-e2e="banner-human"
        >
          <span aria-hidden="true">🙋</span>
          <span className="flex-1 min-w-0">
            <b className="font-semibold">{compact ? "要求真人" : "病人要求真人跟進"}</b>
            {compact ? " · AI 已暫停" : " — AI 自動回覆已暫停，請員工親自回覆"}
            {!compact && flags.humanRequest.at ? <span className="ml-1.5 text-[11px] opacity-70">{hhmm(flags.humanRequest.at)}</span> : null}
          </span>
          {flags.canWrite && (
            <button type="button" onClick={() => void handBack()} disabled={busy !== null} className={btn} data-e2e="banner-human-handback">
              {busy === "human" ? "處理中…" : compact ? "交返 AI" : "交返 AI 繼續"}
            </button>
          )}
        </div>
      )}
      {flags.optOut.active && (
        <div
          className="flex items-center gap-2 rounded-xl px-3 py-1.5 text-[12.5px] bg-panel-2 text-t2 border border-line"
          role="status"
          data-e2e="banner-optout"
        >
          <span aria-hidden="true">🔕</span>
          <span className="flex-1 min-w-0">
            <b className="font-semibold text-t1">{compact ? "已退訂" : "病人已退訂（STOP）"}</b>
            {compact ? " · 唔再主動發" : " — 系統唔會再主動發提醒／跟進；你人手回覆照常可以"}
            {!compact && flags.optOut.at ? <span className="ml-1.5 text-[11px] text-t3">{hhmm(flags.optOut.at)}</span> : null}
          </span>
          {flags.canWrite && flags.optOut.contactId && (
            <button type="button" onClick={() => void resumeFollowup()} disabled={busy !== null} className={btn} data-e2e="banner-optout-resume">
              {busy === "optout" ? "更新中…" : compact ? "恢復" : "恢復跟進"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
