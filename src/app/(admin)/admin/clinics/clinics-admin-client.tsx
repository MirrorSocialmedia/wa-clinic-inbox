"use client";

import { useCallback, useEffect, useState } from "react";
import { relTime } from "@/components/inbox/time";

/**
 * 診所 CRUD client — 逐店卡（Organic P2）+ 建立/編輯（含 greetingConfig JSON 編輯器）+ 刪除。
 * 所有 mutation 經 /api/admin/clinics（ADMIN-only）。
 *
 * ★ 2026-08-29 Organic P2（cwi-uiredesign-20260829-P2，README 第 4 步）：
 * - 7 欄表格 → 一行一店卡（flex-none 防 overflow-auto 壓塌）
 * - AI 模式 text button → segmented（草稿/自動；自動選中 = 陶土橙）
 * - AUTO 店卡整張換裝：border-warn + 底部鐵律條
 * - 所有 confirm() → .dialog modal（開 AUTO / 刪除）；關 AUTO 直接切（README 互動表）
 * - 邏輯零改動：同一組 API 調用、同一組錯誤處理
 */
interface Clinic {
  id: string;
  code: string;
  name: string;
  waPhoneNumberId: string;
  waDisplayNumber: string;
  apricotClinicId: string | null;
  greetingConfig: Record<string, unknown> | null;
  aiMode: "DRAFT" | "AUTO";
  conversationCount: number;
  contactCount: number;
  // API 係 clinic 全 row spread（...c）— 呢兩欄已經喺 response 度（JSON = ISO string）
  qualityRating: string | null; // GREEN / YELLOW / RED（null = 未檢查）
  lastWebhookEventAt: string | null;
}

interface FormState {
  code: string;
  name: string;
  waPhoneNumberId: string;
  waDisplayNumber: string;
  greetingConfig: string; // JSON 文字（編輯器）
}

/** .dialog 二次確認請求 — onConfirm = 原本 confirm() 之後會做嘅個動作 */
interface ConfirmReq {
  title: string;
  body: string;
  label: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

const emptyForm: FormState = {
  code: "",
  name: "",
  waPhoneNumberId: "",
  waDisplayNumber: "",
  greetingConfig: "",
};

const QUALITY_DOT: Record<string, string> = {
  GREEN: "bg-ok",
  YELLOW: "bg-warn",
  RED: "bg-danger",
};

function toForm(c: Clinic): FormState {
  return {
    code: c.code,
    name: c.name,
    waPhoneNumberId: c.waPhoneNumberId,
    waDisplayNumber: c.waDisplayNumber,
    greetingConfig: c.greetingConfig ? JSON.stringify(c.greetingConfig, null, 2) : "",
  };
}

export default function ClinicsAdmin() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Clinic | null>(null); // null=關閉, undefined 以外
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonOkCount, setJsonOkCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<ConfirmReq | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/clinics", { cache: "no-store" });
    if (res.ok) setClinics((await res.json()) as Clinic[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // .dialog modal：Esc 關閉
  useEffect(() => {
    if (!pendingAction) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingAction(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingAction]);

  function openCreate() {
    setForm(emptyForm);
    setJsonError(null);
    setJsonOkCount(0);
    setError(null);
    setCreating(true);
    setEditing(null);
  }

  function openEdit(c: Clinic) {
    setForm(toForm(c));
    setJsonError(null);
    setJsonOkCount(0);
    setError(null);
    setEditing(c);
    setCreating(false);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
  }

  function setGreeting(text: string) {
    setForm((f) => ({ ...f, greetingConfig: text }));
    setJsonError(null);
    setJsonOkCount(0);
    if (!text.trim()) return;
    try {
      const v = JSON.parse(text);
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        setJsonError("必須係 JSON object（例如 { \"address\": \"...\" }）");
      } else {
        setJsonOkCount(Object.keys(v).length);
      }
    } catch {
      setJsonError("JSON 格式錯誤");
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let greetingConfig: unknown = null;
      if (form.greetingConfig.trim()) {
        greetingConfig = JSON.parse(form.greetingConfig);
      }
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        waPhoneNumberId: form.waPhoneNumberId.trim(),
        waDisplayNumber: form.waDisplayNumber.trim(),
        greetingConfig,
      };
      const res = editing
        ? await fetch(`/api/admin/clinics/${editing.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/clinics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; detail?: unknown; issues?: { path: string; message: string }[] }
        | null;
      if (!res.ok) {
        setError(
          body?.issues
            ? body.issues.map((i) => `${i.path}: ${i.message}`).join("；")
            : (body?.error ?? `HTTP ${res.status}`)
        );
        return;
      }
      closeForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function doRemove(c: Clinic) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/clinics/${c.id}`, { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; hint?: string; detail?: Record<string, number> }
        | null;
      if (!res.ok) {
        alert(`${body?.error ?? `HTTP ${res.status}`}\n${body?.hint ?? ""}`);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  function requestRemove(c: Clinic) {
    // 原本 confirm() → .dialog modal（行為不變：confirm=yes = 做同一個 DELETE）
    setPendingAction({
      title: `刪除 ${c.code}`,
      body: "確定刪除？（有對話/聯絡人/員工嘅店會先擋住）",
      label: "刪除",
      danger: true,
      onConfirm: () => doRemove(c),
    });
  }

  // Phase 2b：逐舖 AI 模式切換（DRAFT ↔ AUTO）。AUTO 要有醒目提示 + 二次確認。
  async function doSetMode(c: Clinic, next: "DRAFT" | "AUTO") {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/clinics/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiMode: next }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        alert(`${body?.error ?? `HTTP ${res.status}`}`);
        return;
      }
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "切換失敗");
    } finally {
      setBusy(false);
    }
  }

  function requestSetMode(c: Clinic, next: "DRAFT" | "AUTO") {
    if (next === c.aiMode) return;
    if (next === "AUTO") {
      // 開 AUTO 係有後果嘅操作 → .dialog modal 二次確認（README：唔用 window.confirm）
      setPendingAction({
        title: `為 ${c.code} 開啟 AUTO 模式`,
        body:
          "開啟後：AI 回覆會直接覆病人（唔經 staff 人手確認）。\n\n" +
          "例外（永遠唔會自動發，退回 staff 處理）：\n" +
          "・急症（URGENT_PAIN / HIGH）\n" +
          "・要求人工（needsHuman）\n" +
          "・超出 24 小時客服窗口",
        label: "開啟 AUTO",
        danger: true,
        onConfirm: () => doSetMode(c, "AUTO"),
      });
      return;
    }
    // 關 AUTO 直接切（README 互動表：「關 AUTO 直接切」）
    void doSetMode(c, "DRAFT");
  }

  const input =
    "mt-1 w-full rounded-full bg-panel border border-line-strong px-3.5 py-2 text-sm";
  const label = "block text-[13.5px] text-t2";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[25px] font-normal text-t1">診所管理</h1>
          <p className="text-[13px] text-t2 mt-1">
            逐店設定：WhatsApp 號 / greeting 配置 / AI 模式
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex-none rounded-full bg-brand text-panel font-display text-[13px] px-4 py-2 hover:bg-brand-hover"
        >
          + 新增診所
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-t2">載入中…</p>
      ) : clinics.length === 0 ? (
        <div className="border border-dashed border-line-strong rounded-[26px] p-10 text-center text-sm text-t2">
          未設診所
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {clinics.map((c) => {
            const auto = c.aiMode === "AUTO";
            const connected = c.waPhoneNumberId.length > 0;
            return (
              <article
                key={c.id}
                className={`flex-none flex flex-col bg-panel rounded-[26px] border overflow-hidden ${
                  auto ? "border-[1.5px] border-warn" : "border-line"
                } ${connected ? "" : "opacity-55"}`}
              >
                <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4 px-[18px] py-4">
                  {/* 左：46px 圓形 code chip */}
                  <div className="w-[46px] h-[46px] flex-none rounded-full bg-brand-soft text-brand-text grid place-items-center font-display text-[14px]">
                    {c.code}
                  </div>
                  {/* 中：店名 + quality 色點 + meta 行 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-display text-[16px] text-t1 truncate">{c.name}</span>
                      {c.qualityRating && (
                        <span
                          title={`quality_rating: ${c.qualityRating}`}
                          className={`w-[7px] h-[7px] rounded-full flex-none ${
                            QUALITY_DOT[c.qualityRating] ?? "bg-line-strong"
                          }`}
                        />
                      )}
                    </div>
                    <div className="text-[11.5px] text-t2 mt-1 truncate">
                      <span className="font-mono">{c.waDisplayNumber || "未接入 WhatsApp 號"}</span>
                      {" · 對話 "}
                      {c.conversationCount}
                      {" · 聯絡人 "}
                      {c.contactCount}
                      {c.lastWebhookEventAt
                        ? ` · 最後事件 ${relTime(c.lastWebhookEventAt)}`
                        : " · 無事件"}
                    </div>
                  </div>
                  {/* 右：AI 模式 segmented + 編輯/接入 + 刪除 */}
                  <div className="flex items-center gap-2.5 flex-none">
                    <div
                      className="inline-flex items-center bg-panel-2 rounded-full p-[3px] border border-line"
                      role="group"
                      aria-label={`${c.code} AI 模式`}
                    >
                      {(["DRAFT", "AUTO"] as const).map((m) => {
                        const selected = c.aiMode === m;
                        return (
                          <button
                            key={m}
                            onClick={() => requestSetMode(c, m)}
                            disabled={busy}
                            className={`px-3.5 py-1.5 rounded-full text-[11.5px] font-semibold transition-colors disabled:opacity-50 ${
                              selected
                                ? m === "AUTO"
                                  ? "bg-danger text-panel shadow-sm"
                                  : "bg-panel text-t1 shadow-sm"
                                : "text-t2 hover:text-t1"
                            }`}
                          >
                            {m === "AUTO" ? "自動" : "草稿"}
                          </button>
                        );
                      })}
                    </div>
                    {connected ? (
                      <button
                        onClick={() => openEdit(c)}
                        className="rounded-full border border-line text-[12px] font-semibold px-3.5 py-1.5 text-t1 hover:bg-black/[.06]"
                      >
                        編輯
                      </button>
                    ) : (
                      <a
                        href="/admin/onboarding"
                        className="rounded-full bg-brand text-panel font-display text-[12px] px-3.5 py-1.5 hover:bg-brand-hover"
                      >
                        接入
                      </a>
                    )}
                    <button
                      onClick={() => requestRemove(c)}
                      className="text-[12px] text-danger-text hover:underline"
                    >
                      刪除
                    </button>
                  </div>
                </div>
                {/* AUTO 店鐵律條（陶土橙系） */}
                {auto && (
                  <div className="bg-danger-soft border-t border-warn-soft px-[18px] py-2.5 text-[12px] leading-relaxed text-danger-text">
                    ⚡ <b>AI 正在直接覆病人。</b>永遠不會自動發的例外：急症（URGENT_PAIN／HIGH）、病人要求人工、超出 24
                    小時窗口 — 這三種一律退回員工處理。
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <div className="bg-panel-2 rounded-[26px] p-5 space-y-4 max-w-2xl">
          <h2 className="text-[17px] font-normal text-t1">
            {creating ? "新增診所" : `編輯 ${editing?.code}`}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <label className={label}>
              Code（同 clinic-workforce 一致）
              <input
                className={input}
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </label>
            <label className={label}>
              名稱
              <input
                className={input}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className={label}>
              waPhoneNumberId（Meta，分流 key）
              <input
                className={`${input} font-mono`}
                value={form.waPhoneNumberId}
                onChange={(e) => setForm({ ...form, waPhoneNumberId: e.target.value })}
              />
            </label>
            <label className={label}>
              顯示號碼
              <input
                className={input}
                value={form.waDisplayNumber}
                onChange={(e) => setForm({ ...form, waDisplayNumber: e.target.value })}
              />
            </label>
          </div>
          <label className={label}>
            greetingConfig（JSON — 地址/營業時間/醫生/FAQ，餵 AI 草稿用）
            <textarea
              className="mt-1 w-full rounded-[20px] bg-panel border border-line-strong font-mono text-xs h-40 px-3.5 py-2.5"
              value={form.greetingConfig}
              onChange={(e) => setGreeting(e.target.value)}
              placeholder='{"address": "...", "openingHours": "...", "doctors": [...], "faq": [...]}'
            />
          </label>
          {jsonError ? (
            <p className="text-[13px] text-danger-text">{jsonError}</p>
          ) : jsonOkCount > 0 ? (
            <p className="text-[12.5px] text-ok-text">✓ JSON 格式正確 · {jsonOkCount} 個欄位</p>
          ) : null}
          {error && <p className="text-[13px] text-danger-text">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded-full bg-brand text-panel font-display text-[13px] px-5 py-2 hover:bg-brand-hover disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button
              onClick={closeForm}
              className="rounded-full border border-line-strong text-[13px] px-5 py-2 text-t1 hover:bg-black/[.06]"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* .dialog 二次確認 modal（取代 window.confirm） */}
      {pendingAction && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label={pendingAction.title}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="dialog-title">{pendingAction.title}</h3>
            <p className="dialog-body whitespace-pre-line">{pendingAction.body}</p>
            <div className="dialog-actions">
              <button
                onClick={() => setPendingAction(null)}
                className="rounded-full border border-line-strong px-4 py-2 text-[13px] font-semibold text-t1 hover:bg-black/[.06]"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const act = pendingAction;
                  setPendingAction(null);
                  void act.onConfirm();
                }}
                disabled={busy}
                className={`rounded-full text-panel font-display text-[13px] px-4 py-2 disabled:opacity-50 ${
                  pendingAction.danger
                    ? "bg-danger hover:bg-danger-text"
                    : "bg-brand hover:bg-brand-hover"
                }`}
              >
                {pendingAction.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
