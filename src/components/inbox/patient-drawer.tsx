"use client";

/**
 * 手機半屏抽屜（followup-v2 §3.2 — cwi-followup-p2-20260915）
 *
 * - 佔**下半屏 50vh**，上半仍然見到對話（無遮罩暗化 — 前台要一眼見對話）
 * - 拖高至 90vh（handle pointer 拖）；向下掃過 55vh 線 = 關閉
 * - 內容區獨立捲動（PatientRecordPanel 內 overflow-y:auto）— 唔會連對話一齊捲
 * - 桌面（lg+）唔渲染 — 桌面走右側欄分頁（§3.4）
 *
 * 四角：open=false 或 conversationId=null → 唔渲染。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PatientRecordPanel } from "./patient-record-panel";

const MIN_H = 50; // vh
const MAX_H = 90; // vh
const CLOSE_BELOW = 55; // vh — 掃過呢條線放手 = 關閉

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function PatientDrawer({
  open,
  conversationId,
  onClose,
}: {
  open: boolean;
  conversationId: string | null;
  onClose: () => void;
}) {
  const [h, setH] = useState<number>(MIN_H);
  const [dragging, setDragging] = useState(false);
  const hRef = useRef(MIN_H);
  const drag = useRef<{ startY: number; startH: number; moved: boolean } | null>(null);

  useEffect(() => {
    hRef.current = h;
  }, [h]);
  // 每次開 → 還原 50vh
  useEffect(() => {
    if (open) setH(MIN_H);
  }, [open]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { startY: e.clientY, startH: hRef.current, moved: false };
      setDragging(true);
    },
    [],
  );
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > 5) d.moved = true;
    // 手向上（dy<0）= 抽屜變高；向下 = 變矮
    const next = clamp(d.startH + (-dy / window.innerHeight) * 100, MIN_H, MAX_H);
    setH(next);
  }, []);
  const onPointerUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    if (!d.moved) {
      // 輕彈 handle = 50↔90 切換（便利；唔係必須）
      setH(hRef.current >= MAX_H - 1 ? MIN_H : MAX_H);
      return;
    }
    if (hRef.current <= CLOSE_BELOW) {
      onClose();
      return;
    }
    setH(hRef.current >= (MIN_H + MAX_H) / 2 ? MAX_H : MIN_H);
  }, [onClose]);

  if (!open || !conversationId) return null;

  return (
    <div className="fixed inset-0 z-40 lg:hidden" data-e2e="p2-drawer">
      {/* 上半透明 click-catcher（唔暗化 — 對話保持可見）：撳 = 收埋抽屜 */}
      <div className="absolute inset-x-0 top-0 bottom-0" onClick={onClose} data-e2e="p2-drawer-catcher" style={{ height: `${100 - h}vh` }} />
      <div
        className="absolute inset-x-0 bottom-0 bg-canvas rounded-t-2xl border-t border-line shadow-[0_-4px_24px_rgba(0,0,0,0.08)] flex flex-col"
        style={{ height: `${h}vh`, transition: dragging ? "none" : "height 200ms ease" }}
        data-e2e="p2-drawer-sheet"
        data-height-vh={Math.round(h)}
      >
        <div
          className="shrink-0 flex justify-center py-2 cursor-grab active:cursor-grabbing touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-e2e="p2-drawer-handle"
          aria-label="拖高或向下掃關閉"
        >
          <div className="w-10 h-1 rounded-full bg-line" />
        </div>
        <div className="flex-1 min-h-0">
          <PatientRecordPanel conversationId={conversationId} />
        </div>
      </div>
    </div>
  );
}
