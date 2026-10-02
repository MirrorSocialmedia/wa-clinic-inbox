"use client";

import { useCallback, useEffect, useState } from "react";
import { ensurePermission, ensurePushSubscription } from "@/lib/notify-client";

/**
 * ★ cwi-notify-a4/a7/a8（2026-10-02）：通知設定面板「推送診斷」。
 *
 * 點解要：舊版「發測試通知」只回「已推送 N 部裝置」— N 係帳號所有裝置（電腦／舊手機都計），
 * 而且即時發（app 仲喺前台），分唔到「部機冇收到」定「收到但唔響」。呢度逐部機列：
 *   - 推送服務收貨（lastOkAt）— Google／Apple 接咗
 *   - 部機收到（lastReceivedAt）— 手機 service worker 真係收到（sw.js → /api/push/ack）
 * 再加「10 秒後發測試」：撳完即刻閂 app／鎖機，驗證背景真係響唔響。
 * 加埋 iOS／Android 手機設定教學（a7）同 build 版本（a8 — 一眼確認部機行緊邊個版本）。
 */

interface Device {
  id: string;
  label: string;
  endpointTail: string;
  createdAt: string;
  lastOkAt: string | null;
  lastReceivedAt: string | null;
}

function ago(iso: string | null): string {
  if (!iso) return "未有";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "啱啱";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小時前`;
  return `${Math.round(h / 24)} 日前`;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

const PERM_LABEL: Record<string, string> = {
  granted: "已允許 ✅",
  denied: "已拒絕 ❌（要去手機／瀏覽器設定重新允許）",
  default: "未允許 ⚠️",
  unsupported: "呢個瀏覽器唔支援 ❌",
};

export function PushDiagnostics({ testClinicId }: { testClinicId: string | null }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [vapidReady, setVapidReady] = useState<boolean | null>(null);
  const [myTail, setMyTail] = useState<string | null>(null);
  const [perm, setPerm] = useState<string>("default");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      const sub = await reg?.pushManager?.getSubscription?.();
      setMyTail(sub?.endpoint ? sub.endpoint.slice(-12) : null);
    } catch {
      setMyTail(null);
    }
    try {
      const r = await fetch("/api/push/devices", { cache: "no-store" });
      if (!r.ok) return;
      const d = (await r.json()) as { vapidReady?: boolean; devices?: Device[] };
      setVapidReady(d.vapidReady ?? null);
      setDevices(Array.isArray(d.devices) ? d.devices : []);
    } catch {
      /* 離線 — 保留舊顯示 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enableHere = async () => {
    setBusy(true);
    try {
      const p = await ensurePermission(); // 用戶撳掣 = 手勢（iOS 一定要喺已安裝 app 入面撳）
      if (p === "granted") {
        const ok = await ensurePushSubscription();
        setMsg(ok ? "呢部機已訂閱推送 ✅" : "訂閱失敗 — 確認係由主畫面 icon 開嘅 App，再試");
      } else {
        setMsg("通知權限未允許");
      }
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const delayedTest = async () => {
    if (!testClinicId) {
      setMsg("揀一間店先（列表頂部店舖選擇）");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/push/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clinicId: testClinicId, delaySec: 10 }),
      });
      const d = (await r.json().catch(() => null)) as { result?: string; clinicShort?: string } | null;
      if (d?.result === "scheduled") {
        setMsg("10 秒後推送「測試通知」— 而家即刻閂 app 或者鎖機。之後返嚟撳「重新整理」睇結果。");
        window.setTimeout(() => void refresh(), 25_000);
      } else if (d?.result === "muted") {
        setMsg(`呢間店（${d.clinicShort}）被你靜音咗 — 測唔到`);
      } else {
        setMsg(`排程失敗（${r.status}）`);
      }
    } catch {
      setMsg("排程失敗（網絡）");
    } finally {
      setBusy(false);
    }
  };

  const mine = devices?.find((x) => myTail && x.endpointTail === myTail) ?? null;
  const ios = isIos();
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

  return (
    <div className="pt-1.5 border-t border-line space-y-1.5" data-testid="push-diagnostics">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold text-t3 uppercase tracking-wide">推送診斷</div>
        <button type="button" onClick={() => void refresh()} className="text-[10px] text-brand-text hover:underline">
          重新整理
        </button>
      </div>
      <div className="text-[11px] text-t2 leading-snug space-y-0.5">
        <div>通知權限：{PERM_LABEL[perm] ?? perm}</div>
        <div>
          伺服器推送：{vapidReady === null ? "…" : vapidReady ? "已配置 ✅" : "未配置 ❌（VAPID key — 通知管理員）"}
        </div>
        <div>呢部機：{mine ? "已訂閱 ✅" : myTail ? "已訂閱（未同步到伺服器 ⚠️）" : "未訂閱 ⚠️"}</div>
      </div>
      {perm !== "unsupported" && (!mine || perm !== "granted") && (
        <button
          type="button"
          onClick={() => void enableHere()}
          disabled={busy}
          className="w-full text-xs text-white bg-brand rounded-lg px-2 py-1.5 disabled:opacity-50"
        >
          喺呢部機開啟通知
        </button>
      )}
      {devices && devices.length > 0 && (
        <ul className="space-y-1">
          {devices.map((d) => {
            const isMine = myTail !== null && d.endpointTail === myTail;
            // 推送服務收咗但部機一直冇收到（> 2 分鐘差）→ 手機端問題
            const stuck =
              d.lastOkAt !== null &&
              (d.lastReceivedAt === null ||
                new Date(d.lastOkAt).getTime() - new Date(d.lastReceivedAt).getTime() > 120_000);
            return (
              <li key={d.id} className="rounded-lg bg-panel-2 px-2 py-1 text-[10.5px] text-t2 leading-snug">
                <div className="font-semibold text-t1">
                  {d.label}
                  {isMine && <span className="ml-1 text-brand-text">（呢部機）</span>}
                </div>
                <div>推送服務收貨：{ago(d.lastOkAt)} · 部機收到：{ago(d.lastReceivedAt)}</div>
                {stuck && <div className="text-warn-text">⚠ 推送服務收咗但部機未收到 — 睇下面手機設定</div>}
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        onClick={() => void delayedTest()}
        disabled={busy}
        className="w-full text-xs text-t1 hover:bg-black/[.04] rounded-lg px-2 py-1.5 border border-line disabled:opacity-50"
      >
        10 秒後發測試（撳完即刻閂 app／鎖機）
      </button>
      {msg && <div className="text-[11px] text-t2 px-1 break-words">{msg}</div>}
      <details className="text-[10.5px] text-t2 leading-snug">
        <summary className="cursor-pointer text-t1">收唔到通知／冇聲？手機設定</summary>
        <div className="mt-1 space-y-1.5">
          {[ios ? "ios" : "android", ios ? "android" : "ios"].map((k) =>
            k === "ios" ? (
              <div key="ios">
                <div className="font-semibold text-t1">iPhone／iPad（iOS 16.4 或以上）</div>
                <ol className="list-decimal pl-4 space-y-0.5">
                  <li>一定要用 Safari「分享 → 加入主畫面」，之後<b>由主畫面 icon 開</b>（Safari 分頁收唔到背景通知）</li>
                  <li>喺 App 入面撳上面「喺呢部機開啟通知」→ 允許</li>
                  <li>設定 → 通知 → WA Clinic：允許通知、<b>聲音</b>開、橫額／鎖定畫面開</li>
                  <li>專注模式（勿擾／睡眠／工作）要將 WA Clinic 加入「允許的 App」</li>
                  <li>提示音係 iOS 系統預設聲（網頁 App 唔可以自訂）</li>
                </ol>
              </div>
            ) : (
              <div key="android">
                <div className="font-semibold text-t1">Android</div>
                <ol className="list-decimal pl-4 space-y-0.5">
                  <li>用 Chrome「加入主畫面／安裝 App」，由主畫面 icon 開</li>
                  <li>設定 → 應用程式 → Chrome（同 WA Clinic）→ 電池 → <b>不受限制</b></li>
                  <li>設定 → 通知 → WA Clinic → 每個類別：<b>聲音</b>開、重要性「緊急／高」（可以揀手機內建鈴聲）</li>
                  <li>小米／華為／OPPO／vivo：開「自動啟動」同「背景彈出」</li>
                </ol>
              </div>
            )
          )}
          <div>用「10 秒後發測試」：鎖機後有通知 + 聲 = 設定正確；上面「部機收到」有時間但冇聲 = 手機聲音／專注模式設定問題。</div>
        </div>
      </details>
      <div className="text-[9px] text-t3/80 font-mono">版本 {version}</div>
    </div>
  );
}
