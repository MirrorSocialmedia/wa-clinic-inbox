"use client";

/**
 * ★ cwi-workgroup-p2-20261105：外部對話 UI
 * - MarkExternalDialog：對話 ⋯ →「標記做外部人 → 移去工作群」（名、公司）
 * - ExternalBanner：外部對話頂部橫額（邊個／邊間公司 + 取消標記）
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";

export function MarkExternalDialog({ conversationId, defaultName, onClose }: { conversationId: string; defaultName: string; onClose: () => void }) {
  const [name, setName] = useState(defaultName.slice(0, 40));
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/external`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, org: org || null }),
      });
      const d = (await r.json().catch(() => null)) as { message?: string } | null;
      if (!r.ok) {
        setErr(d?.message ?? "標記失敗");
        return;
      }
      onClose();
    } catch {
      setErr("網絡錯誤，請再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label="標記做外部人">
      <button type="button" className="absolute inset-0 bg-black/30" aria-label="關閉" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-3xl bg-panel p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl md:rounded-3xl" data-e2e="ext-dialog">
        <div className="mb-3 flex items-center">
          <div className="text-[15px] font-semibold text-t1">標記做外部人</div>
          <button type="button" onClick={onClose} className="ml-auto rounded-full p-1 hover:bg-panel-2" aria-label="關閉">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-t2">
          例如 Lab 師傅、供應商 — 唔係病人。標記之後呢個對話會搬去「工作群 → 外部對話」，唔再觸發 AI 自動覆、預約、銷售保護、跟進，亦唔計入未指派。佢之後再 WhatsApp 嚟都會直接去外部對話。
        </p>
        <label className="block text-[12px] text-t2">
          對方名
          <input
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：陳師傅"
            className="mt-1 w-full rounded-full border border-line bg-panel-2 px-3.5 py-2 text-sm text-t1"
            data-e2e="ext-name"
          />
        </label>
        <label className="mt-3 block text-[12px] text-t2">
          公司（可以唔填）
          <input
            value={org}
            maxLength={60}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="例如：明德 Lab"
            className="mt-1 w-full rounded-full border border-line bg-panel-2 px-3.5 py-2 text-sm text-t1"
            data-e2e="ext-org"
          />
        </label>
        {err && <div className="mt-2 text-xs text-danger-text">{err}</div>}
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void save()}
          className="mt-4 w-full rounded-full bg-brand py-2.5 text-sm font-medium text-panel disabled:opacity-50"
          data-e2e="ext-save"
        >
          {busy ? "處理緊…" : "標記並移去工作群"}
        </button>
      </div>
    </div>
  );
}

export function ExternalBanner({
  conversationId,
  name,
  org,
  canEdit,
}: {
  conversationId: string;
  name: string | null;
  org: string | null;
  canEdit: boolean;
}) {
  const [info, setInfo] = useState<{ name: string; org: string | null } | null>(name ? { name, org } : null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/external`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { external: { name: string; org: string | null } | null } | null) => {
        if (!cancelled && d?.external) setInfo(d.external);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  async function unmark() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/external`, { method: "DELETE" });
      const d = (await r.json().catch(() => null)) as { message?: string } | null;
      if (!r.ok) setErr(d?.message ?? "取消失敗");
    } catch {
      setErr("網絡錯誤");
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-ok-soft px-3 py-1.5 text-[12px] text-ok-text" data-e2e="ext-banner">
      <span className="font-semibold">外部對話</span>
      <span className="min-w-0 truncate">
        {info ? `${info.name}${info.org ? ` · ${info.org}` : ""}` : "外部人"} — 唔係病人；唔會觸發 AI、預約、銷售、跟進
      </span>
      {err && <span className="text-danger-text">{err}</span>}
      {canEdit && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void unmark()}
          className={`ml-auto shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] ${armed ? "border-warn-text text-warn-text" : "border-line"} disabled:opacity-50`}
          data-e2e="ext-unmark"
        >
          {busy ? "處理緊…" : armed ? "再撳一次：返返收件箱？" : "取消外部標記"}
        </button>
      )}
    </div>
  );
}
