"use client";

/**
 * /admin/onboarding — WhatsApp Embedded Signup 客戶端（App Review §2）。
 *
 * 流程（MD §2.2）：
 *  1. 動態載入 FB SDK（v23.0）→ FB.init
 *  2. FB.login(callback, { config_id, response_type: "code", extras }) → Meta 彈 Embedded Signup 框
 *  3. Meta 透過 postMessage（origin 必查 facebook.com）通知結果：
 *     FINISH / FINISH_ONLY_WABA（帶 phone_number_id + waba_id）/ CANCEL / ERROR
 *  4. 攞到 code 後 POST /api/admin/onboarding/exchange 做 token 交換 + phone register
 *     + WABA subscribe + 寫入 clinic.waPhoneNumberId（server 端，見 route.ts）
 *
 * ★ 三個最易隨 Meta 版本變動嘅字串（實測日對官方 Embedded Signup 文檔逐字核實）：
 *   - featureType: "whatsapp_business_app_onboarding"
 *   - postMessage type: "WA_EMBEDDED_SIGNUP"
 *   - sessionInfoVersion: "3"
 *
 * 安全：postMessage 必查 origin（只收 https://*.facebook.com，防止 notfacebook.com 字尾碰巧匹配）；
 * code 只送自己 /api/admin/onboarding/exchange，唔入 log、唔入 DB。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface OnboardingClinic {
  id: string;
  code: string;
  name: string;
  waPhoneNumberId: string | null;
}

const FB_SDK_VERSION = "v23.0";
const FB_SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
const EXCHANGE_URL = "/api/admin/onboarding/exchange";

// ★ 易變字串（實測日對官方文檔）— 見檔案頭註
const FB_FEATURE_TYPE = "whatsapp_business_app_onboarding";
const FB_SIGNUP_MESSAGE_TYPE = "WA_EMBEDDED_SIGNUP";
const FB_SESSION_INFO_VERSION = "3";

/** 只信 https + facebook.com 域名（含子域）。嚴於「字尾 facebook.com」：notfacebook.com 唔會匹配。 */
function isFacebookOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return false;
    return u.hostname === "facebook.com" || u.hostname.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

interface MetaSignupPayload {
  type?: string;
  current_step?: string; // FINISH / FINISH_ONLY_WABA / CANCEL / ERROR
  phone_number_id?: string;
  waba_id?: string;
  error_message?: string;
}

/** FB SDK 最小類型（避免 any — eslint no-explicit-any） */
interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  error?: string | null;
  error_description?: string | null;
}
interface FbSdk {
  init?: (opts: Record<string, unknown>) => void;
  login?: (cb: (resp: FbLoginResponse) => void, opts?: Record<string, unknown>) => void;
}

type Phase = "idle" | "loading-sdk" | "sdk-ready" | "pending" | "done" | "cancelled" | "error";

interface StatusInfo {
  phase: Phase;
  title: string;
  detail?: string;
}

export function OnboardingClient({ clinics }: { clinics: OnboardingClinic[] }) {
  const [clinicId, setClinicId] = useState<string>(clinics[0]?.id ?? "");
  const [status, setStatus] = useState<StatusInfo>({
    phase: "idle",
    title: "未開始",
    detail: "揀診所 → 點「開始 Embedded Signup」。首步必須喺 FB Dashboard 完成預前置（App Review MD §2.1）。",
  });
  const [busy, setBusy] = useState(false);
  const sdkReadyRef = useRef(false);
  const clinicIdRef = useRef(clinicId);
  clinicIdRef.current = clinicId;

  const appId = process.env.NEXT_PUBLIC_FB_APP_ID ?? "";
  const configId = process.env.NEXT_PUBLIC_FB_CONFIG_ID ?? "";
  const envMissing = !appId || !configId;

  // FB.login 攞到 code 後先跑 exchange（code 同 phone_number_id 到達順序不定 — 兩路都處理）
  const pendingCodeRef = useRef<string | undefined>(undefined);
  const idsRef = useRef<{ phoneNumberId?: string; wabaId?: string } | undefined>(undefined);

  /** 攞到 auth code → exchange。code 唔印 log（server 端同理零入 log）。 */
  const runExchange = useCallback(async (code: string, ids: { phoneNumberId?: string; wabaId?: string }) => {
    setStatus({ phase: "pending", title: "Exchange 中…", detail: "token 交換 → phone register → WABA subscribe → 寫入 clinic" });
    try {
      const res = await fetch(EXCHANGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, clinicId: clinicIdRef.current, phoneNumberId: ids.phoneNumberId, wabaId: ids.wabaId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { clinicCode?: string; phoneNumberId?: string; wabaId?: string; step?: string; httpStatus?: number | null; error?: string }
        | null;
      if (!res.ok || !data) {
        const step = data?.step ? `${data.step}` : "unknown";
        const httpStatus = data?.httpStatus != null ? `（http ${data.httpStatus}）` : "";
        setStatus({ phase: "error", title: "Exchange 失敗", detail: `${step} ${httpStatus}: ${data?.error ?? res.status}` });
        return;
      }
      setStatus({
        phase: "done",
        title: "完成 ✓",
        detail: `clinic ${data.clinicCode} ← ${data.phoneNumberId}${data.wabaId ? `（WABA ${data.wabaId}）` : ""}。下一步：/admin/clinics 更新 Webhook URL 並點 Verify。`,
      });
    } catch (err) {
      setStatus({ phase: "error", title: "Exchange 失敗", detail: err instanceof Error ? err.message : "network error" });
    } finally {
      setBusy(false);
    }
  }, []);

  /** postMessage 監聽 — 必查 origin（App Review 安全要求）。 */
  const onPostMessage = useCallback(
    (event: MessageEvent) => {
      if (!isFacebookOrigin(event.origin)) return; // 唔係 facebook.com → 靜默 drop
      const d = event.data as MetaSignupPayload;
      if (!d || d.type !== FB_SIGNUP_MESSAGE_TYPE) return;

      if (d.current_step === "FINISH" || d.current_step === "FINISH_ONLY_WABA") {
        if (d.phone_number_id) {
          // 攞咗 phone number id → 如果 FB.login callback 已攞到 code，即刻 exchange
          if (pendingCodeRef.current) {
            runExchange(pendingCodeRef.current, { phoneNumberId: d.phone_number_id, wabaId: d.waba_id });
            pendingCodeRef.current = undefined;
          } else {
            idsRef.current = { phoneNumberId: d.phone_number_id, wabaId: d.waba_id };
            setStatus({ phase: "pending", title: "已攞到 phone number", detail: "等待 auth code…" });
          }
        }
      } else if (d.current_step === "CANCEL") {
        setStatus({ phase: "cancelled", title: "已取消", detail: "Meta 框已取消。可再試。" });
        setBusy(false);
      } else if (d.current_step === "ERROR") {
        setStatus({ phase: "error", title: "Embedded Signup 錯誤", detail: d.error_message ?? "unknown" });
        setBusy(false);
      }
    },
    [runExchange]
  );

  const onAuthCode = useCallback(
    (code: string) => {
      const ids = idsRef.current;
      if (ids?.phoneNumberId) {
        runExchange(code, ids);
        idsRef.current = undefined;
      } else {
        pendingCodeRef.current = code;
        setStatus({ phase: "pending", title: "已攞到 auth code", detail: "等待 phone_number_id…" });
      }
    },
    [runExchange]
  );

  // ── SDK 載入（一次） ─────────────────────────────────────────────
  useEffect(() => {
    if (envMissing) return; // env 未設 → 唔載 SDK（UI 有提示）
    const w = window as unknown as { FB?: FbSdk; fbAsyncInit?: () => void };
    const boot = () => {
      // postMessage listener 喺 FB.init 之前挂（避免漏掉早期事件）
      window.addEventListener("message", onPostMessage);
      w.fbAsyncInit = () => {
        w.FB?.init?.({ appId, version: FB_SDK_VERSION, cookie: true, xfbml: false });
        sdkReadyRef.current = true;
        setStatus((s) => (s.phase === "idle" ? { phase: "sdk-ready", title: "SDK 就緒", detail: "可開始 Embedded Signup。" } : s));
      };
      if (w.FB) {
        // SDK 已喺 page 上（同域其他入口先載入）→ 直接 init
        w.fbAsyncInit();
        return;
      }
      const existing = document.getElementById("fb-sdk") as HTMLScriptElement | null;
      if (existing) {
        // 既有 script tag（FB SDK 自己會喺 load 後 call fbAsyncInit；load 事件再做一層保底）
        existing.addEventListener("load", () => w.fbAsyncInit?.());
      } else {
        const s = document.createElement("script");
        s.id = "fb-sdk";
        s.src = FB_SDK_SRC;
        s.async = true;
        s.defer = true;
        s.onerror = () => setStatus({ phase: "error", title: "FB SDK 載入失敗", detail: "網絡連唔到 connect.facebook.net？" });
        document.head.appendChild(s);
      }
    };
    boot();
    return () => window.removeEventListener("message", onPostMessage);
  }, [appId, envMissing, onPostMessage]);

  const launch = useCallback(() => {
    const w = window as unknown as { FB?: FbSdk };
    if (!w.FB?.login) {
      setStatus({ phase: "error", title: "SDK 未就緒", detail: "FB SDK 仲未載入完，稍後再試。" });
      return;
    }
    if (!clinicIdRef.current) return;
    setBusy(true);
    pendingCodeRef.current = undefined;
    idsRef.current = undefined;
    setStatus({ phase: "pending", title: "打開 Embedded Signup 框…", detail: "跟 Meta 指引（揀/換 phone number）直到 FINISH。" });

    w.FB.login(
      (resp: FbLoginResponse) => {
        if (resp?.authResponse?.code) {
          onAuthCode(String(resp.authResponse.code));
        } else if (resp?.error === "access_denied" || resp?.error === "auth canceled") {
          setStatus({ phase: "cancelled", title: "已取消", detail: "FB.login 已取消。" });
          setBusy(false);
        } else {
          setStatus({ phase: "error", title: "FB.login 錯誤", detail: resp?.error_description ?? resp?.error ?? "unknown" });
          setBusy(false);
        }
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        // ★ 易變字串（實測日對官方文檔）
        extras: { setup: {}, featureType: FB_FEATURE_TYPE, sessionInfoVersion: FB_SESSION_INFO_VERSION },
      }
    );
  }, [configId, onAuthCode]);

  const sel = "mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand";
  const phaseCls: Record<Phase, string> = {
    idle: "bg-panel-2 text-t2",
    "loading-sdk": "bg-panel-2 text-t2",
    "sdk-ready": "bg-ok-soft text-ok-text",
    pending: "bg-warn-soft text-warn-text",
    done: "bg-ok-soft text-ok-text",
    cancelled: "bg-panel-2 text-t2",
    error: "bg-danger-soft text-danger-text",
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-panel rounded-lg border border-line p-6 space-y-4">
        <h2 className="text-lg font-semibold">WhatsApp Embedded Signup</h2>
        <p className="text-sm text-t2">
          將某診所嘅 WhatsApp 號註冊入本系統（phone number register + WABA subscribe + 寫入 clinic.waPhoneNumberId）。
          完成後去 <span className="font-mono text-xs">/admin/clinics</span> 更新 Webhook URL 並 Verify。
        </p>

        {envMissing && (
          <div className="rounded-md bg-danger-soft border border-danger/40 px-3 py-2 text-sm text-danger-text">
            缺少 <span className="font-mono">NEXT_PUBLIC_FB_APP_ID</span> / <span className="font-mono">NEXT_PUBLIC_FB_CONFIG_ID</span>（.env）。
            FB Dashboard 建咗 App + Embedded Signup 後先填。
          </div>
        )}

        <label className="block text-sm">
          目標診所
          <select className={sel} value={clinicId} onChange={(e) => setClinicId(e.target.value)} disabled={busy || envMissing}>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
                {c.waPhoneNumberId ? `（現 ${c.waPhoneNumberId}）` : "（未註冊）"}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={launch}
          disabled={busy || envMissing || !clinicId}
          className="rounded-md bg-brand text-white text-sm px-4 py-2 hover:bg-brand-hover disabled:opacity-50"
        >
          {busy ? "進行中…" : "開始 Embedded Signup"}
        </button>
      </div>

      <div className={`rounded-lg border border-line px-4 py-3 text-sm ${phaseCls[status.phase]}`}>
        <div className="font-semibold">{status.title}</div>
        {status.detail && <div className="mt-1 text-sm opacity-90">{status.detail}</div>}
      </div>

      <div className="bg-panel rounded-lg border border-line p-5 text-sm text-t2 space-y-2">
        <div className="font-semibold text-t1">用前必读（App Review MD §2.2）</div>
        <ol className="list-decimal pl-5 space-y-1">
          <li>FB App 註冊 WhatsApp Business 後，此 App 就唔可以移除（要等 90 日）。</li>
          <li>App 最少每 13 日要喺 FB 打開一次，否則會被 FB 回收。</li>
          <li>歷史對話（6 個月）嘅一次性 record import 只係一次性。</li>
        </ol>
        <p className="text-xs opacity-80">
          首步預前置（FB Dashboard）見 App Review MD §2.1：建 App → Embedded Signup → 攞 config_id → 實測日對官方文檔核實三個易變字串。
        </p>
      </div>
    </div>
  );
}
