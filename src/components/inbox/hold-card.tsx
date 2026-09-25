"use client";

/**
 * 預約卡 — Flow 硬保留 hold 兩態（providerslot-20260830 T3 — MD §五/§六 設計稿 3c 右）
 *
 * HELD      = 「🕓 線上已佔 · 等你入 Apricot」+ 主按鈕「已入 Apricot · 完成」
 *             → POST /api/flows/holds/[id]/commit（workforce HELD→IN_APRICOT + 本地 COMMITTED）
 * IN_APRICOT / COMMITTED = 「✅ 已入 Apricot · 完成」（workforce 側 commit 或本地 commit 均到呢度）
 *
 * 數據源 = 本地 FlowHoldEvent（病人資料落 inbox 本地 — 前台睇到；workforce 端零 PII）。
 * RELEASED/EXPIRED = 終態，payload 唔帶（卡消失 — MD §5.3：HELD 過期行警報路徑，唔靜靜消失）。
 * 風格 = P4 預約卡（rounded-[26px] + 色帶卡頭）。
 */
import { useState } from "react";
import { CalendarDays, CheckCircle2, Hourglass } from "lucide-react";
import type { HoldInfo } from "./types";

function fmtHoldDay(dateStr: string): { main: string; weekday: string } {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  const main = `${d.toLocaleDateString("zh-HK", { month: "long", day: "numeric", timeZone: "Asia/Hong_Kong" })}`;
  const weekday = d.toLocaleDateString("zh-HK", { weekday: "short", timeZone: "Asia/Hong_Kong" });
  return { main, weekday };
}

function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function HoldCard({
  hold,
  locked,
  onActionDone,
}: {
  hold: HoldInfo;
  /** Send Lock：有負責人且唔係自己 → 掣停用（同 booking 卡一致） */
  locked?: boolean;
  onActionDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // ★ cwi-final S5-11（F4）：commit 必填 Apricot 單號（staff 入完單先撳完成）
  const [apricotRef, setApricotRef] = useState("");
  // ★ cwi-final S5-8②（F2）：commit 207（新單已入、舊單 102 標記失敗）→ 卡上保留提示
  const [noteMsg, setNoteMsg] = useState<string | null>(null);
  const day = fmtHoldDay(hold.date);
  const isHeld = hold.status === "HELD";

  async function doCommit() {
    if (busy || !isHeld) return;
    if (!apricotRef.trim()) {
      setErrMsg("請填 Apricot 單號先完成");
      return;
    }
    setBusy(true);
    setErrMsg(null);
    try {
      const res = await fetch(`/api/flows/holds/${hold.id}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apricotRef: apricotRef.trim() }),
      });
      const j = (await res.json().catch(() => null)) as { error?: string; status?: string; already?: boolean; notice?: boolean; message?: string } | null;
      if (res.ok || res.status === 207) {
        // 父組 re-fetch 會帶新狀態落嚟（COMMITTED / EXPIRED）
        // ★ cwi-final S5-8②（F2）：207 = 新單已入但舊單 102 標記失敗（StaffNotice 已出）
        if (j?.notice) setNoteMsg(j.message ?? "新單已入，舊單標記失敗，請人手處理");
        onActionDone?.();
      } else if (res.status === 400 || res.status === 409) {
        // ★ cwi-final S5-11（F4）：400 = 缺單號；409 = hold 已非 HELD 或 單號核對唔過（訊息由 backend 帶）
        setErrMsg(j?.error ?? (res.status === 409 ? "呢個 hold 已唔係 HELD（可能已入 Apricot 或已放開）— 刷新中" : "請填 Apricot 單號先完成"));
        onActionDone?.();
      } else if (res.status === 502) {
        setErrMsg("clinic-workforce 連唔到 — 稍後重試（位數仍然佔住）");
      } else {
        setErrMsg(j?.error ?? `commit 失敗（HTTP ${res.status}）`);
      }
    } catch {
      setErrMsg("network error — 請重試");
    } finally {
      setBusy(false);
    }
  }

  // ── 完成態（IN_APRICOT / COMMITTED）──
  if (!isHeld) {
    return (
      <div className="mb-2 rounded-[26px] overflow-hidden bg-ok-soft border-[1.5px] border-brand">
        <div className="px-4 pt-3 pb-3 bg-ok">
          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.1em] uppercase opacity-90">
            <CheckCircle2 size={12} strokeWidth={2.75} /> 預約 · 硬保留
          </div>
          <div className="font-display text-[22px] leading-[1.15] mt-1.5">✅ 已入 Apricot · 完成</div>
          <div className="text-xs opacity-90 mt-0.5">
            {day.main}（{day.weekday}）{minToHHmm(hold.startMin)}–{minToHHmm(hold.endMin)} · {hold.providerName}
            {/* ★ cwi-final S5-11（F4）：clinic code（跨店 staff 分辨 hold 屬邊間店） */}
            <span className="font-mono ml-1.5">{hold.clinicCode}</span>
          </div>
        </div>
        <div className="px-4 py-2.5 flex items-center gap-3 text-[12px]">
          <span className="text-t2">
            病人 <span className="font-semibold text-t1">{hold.patientName ?? "—"}</span>
            <span className="text-t3 font-mono ml-1.5">{hold.patientPhone ?? "—"}</span>
            {/* ★ cwi-final S5-11（F4）：病人喺 Flow 打嘅電話（同 waId 分清） */}
            {hold.contactPhone && <span className="text-t3 ml-1.5">（留嘅電話 {hold.contactPhone}）</span>}
          </span>
          {noteMsg && <span className="text-[10.5px] text-danger-text">⚠️ {noteMsg}</span>}
          {hold.committedAt && (
            <span className="ml-auto text-[10.5px] text-ok-text">
              {new Date(hold.committedAt).toLocaleString("zh-HK", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 完成
            </span>
          )}
        </div>
      </div>
    );
  }

  // ── HELD 態（等你入 Apricot）──
  return (
    <div className="mb-2 rounded-[26px] overflow-hidden bg-warn-soft border-[1.5px] border-warn">
      <div className="px-4 pt-3 pb-3 bg-warn">
        <div className="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.1em] uppercase text-warn-text">
          <Hourglass size={12} strokeWidth={2.75} /> 預約 · 硬保留
        </div>
        <div className="font-display text-[22px] leading-[1.15] mt-1.5 text-warn-text">🕓 線上已佔 · 等你入 Apricot</div>
        <div className="text-xs text-warn-text/90 mt-0.5">
          {day.main}（{day.weekday}）{minToHHmm(hold.startMin)}–{minToHHmm(hold.endMin)} · {hold.providerName}
          {/* ★ cwi-final S5-11（F4）：clinic code（跨店 staff 分辨 hold 屬邊間店） */}
          <span className="font-mono ml-1.5">{hold.clinicCode}</span>
        </div>
      </div>
      <div className="px-4 py-3 flex flex-col gap-2">
        {/* ★ cwi-final S5-8②（F2）：T4 改期 context 紅標 — 舊單唔自動取消，staff 入完新單要手取消舊單
            （{date time} = BR join 嘅舊單預約時間；電話落單無 BR → 顯示舊單號） */}
        {hold.rescheduleOfApptId && (
          <div className="rounded-xl bg-danger-soft border border-danger/40 px-3 py-2 text-[11px] leading-relaxed text-danger-text">
            ⚠️ 改期：舊單 {hold.rescheduleOfApptLabel ?? hold.rescheduleOfApptId} 仍然有效 — 入完新單要取消舊單
          </div>
        )}
        {noteMsg && <div className="rounded-xl bg-danger-soft border border-danger/40 px-3 py-2 text-[11px] text-danger-text">⚠️ {noteMsg}</div>}
        <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
          <span className="text-t2 shrink-0">病人</span>
          <span className="font-semibold text-t1 text-right">
            {hold.patientName ?? "—"}
            <span className="text-t3 font-mono ml-1.5 text-[11px]">{hold.patientPhone ?? "—"}</span>
          </span>
        </div>
        {/* ★ cwi-final S5-11（F4）：病人喺 Flow 打嘅電話（同 waId 分清） */}
        {hold.contactPhone && (
          <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="text-t2 shrink-0">病人留嘅電話</span>
            <span className="text-t1 text-right font-mono">{hold.contactPhone}</span>
          </div>
        )}
        {hold.notes && (
          <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="text-t2 shrink-0">備註</span>
            <span className="text-t1 text-right">{hold.notes}</span>
          </div>
        )}
        <div className="text-[10.5px] text-warn-text">
          位數已經線上佔住（workforce 硬保留）— 超時未入 Apricot 會落 /admin 警報（12h MEDIUM / 24h HIGH）
        </div>
        {/* ★ cwi-final S5-11（F4）：commit 必填 Apricot 單號（backend fetchAppointments 核對存在 + 時間一致） */}
        <div className="flex items-center gap-2">
          <input
            value={apricotRef}
            onChange={(e) => setApricotRef(e.target.value)}
            placeholder="Apricot 單號（入完單先撳完成）"
            maxLength={64}
            className="flex-1 rounded-full border border-line bg-panel px-3.5 py-1.5 text-xs outline-none focus:border-brand"
          />
          <button
            onClick={() => void doCommit()}
            disabled={busy || locked || !apricotRef.trim()}
            title={locked ? "Send Lock：只有負責人可以 commit" : !apricotRef.trim() ? "請填 Apricot 單號" : undefined}
            className="inline-flex items-center gap-1.5 text-xs px-3.5 py-1.5 rounded-full bg-brand hover:bg-brand-hover text-panel font-semibold disabled:opacity-50"
          >
            <CalendarDays size={13} strokeWidth={2.75} />
            {busy ? "處理中…" : "已入 Apricot · 完成"}
          </button>
        </div>
        {errMsg && <div className="text-[11px] text-danger-text">{errMsg}</div>}
      </div>
    </div>
  );
}
