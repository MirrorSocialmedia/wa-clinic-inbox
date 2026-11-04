"use client";

/**
 * ★ cwi-workgroup-20261104：喺病人對話「⋯ → 分享去工作群」— 揀群 + 打一句 → 群入面出對話卡。
 * 卡只存對話 id；群入面每個人睇到幾多跟返自己權限（冇權嗰間店 → 唔顯示病人資料）。
 * ★ p2：「分享並放手」— 對話放返未指派，卡上出「我接」（只限負責人／管理員見呢粒掣）。
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

interface G {
  id: string;
  name: string;
  archived: boolean;
}

function newKey(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function ShareToWorkgroupDialog({ conversationId, canRelease = false, onClose }: { conversationId: string; canRelease?: boolean; onClose: () => void }) {
  const [groups, setGroups] = useState<G[] | null>(null);
  const [gid, setGid] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const key = useRef<string | null>(null);

  useEffect(() => {
    fetch("/api/workgroups")
      .then((r) => (r.ok ? r.json() : { groups: [] }))
      .then((d: { groups: G[] }) => {
        const open = d.groups.filter((g) => !g.archived);
        setGroups(open);
        if (open[0]) setGid(open[0].id);
      })
      .catch(() => setGroups([]));
  }, []);

  async function share(release: boolean) {
    if (!gid || busy) return;
    setBusy(true);
    setMsg(null);
    key.current ??= newKey();
    try {
      const r = await fetch(`/api/workgroups/${encodeURIComponent(gid)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text, conversationId, clientKey: key.current, ...(release ? { release: true } : {}) }),
      });
      const d = (await r.json().catch(() => null)) as { message?: string; releaseFailed?: boolean } | null;
      if (!r.ok) {
        setMsg({ ok: false, t: d?.message ?? "分享失敗" });
        if (r.status < 500 && r.status !== 429) key.current = null;
        return;
      }
      if (d?.releaseFailed) {
        setMsg({ ok: false, t: "已分享，但放手失敗（可能啱啱有人改咗負責人）— 請喺對話頂部再放手" });
        return;
      }
      setMsg({ ok: true, t: release ? "已分享並放手 — 等同事撳「我接」" : "已分享" });
      window.setTimeout(onClose, 900);
    } catch {
      setMsg({ ok: false, t: "網絡錯誤 — 再撳一次會重試（唔會重複）" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label="分享去工作群">
      <button type="button" className="absolute inset-0 bg-black/30" aria-label="關閉" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-3xl bg-panel p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl md:rounded-3xl" data-e2e="wg-share">
        <div className="mb-3 flex items-center">
          <div className="text-[15px] font-semibold text-t1">分享去工作群</div>
          <button type="button" onClick={onClose} className="ml-auto rounded-full p-1 hover:bg-panel-2" aria-label="關閉">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {groups === null ? (
          <div className="py-4 text-center text-sm text-t3">載入中…</div>
        ) : groups.length === 0 ? (
          <div className="py-4 text-center text-sm text-t3">你未加入任何工作群（請老闆加你入群）</div>
        ) : (
          <>
            <label className="block text-[12px] text-t2">
              群組
              <select value={gid} onChange={(e) => setGid(e.target.value)} className="mt-1 w-full rounded-full border border-line bg-panel-2 px-3 py-2 text-sm" data-e2e="wg-share-group">
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-[12px] text-t2">
              留言（可以唔寫）
              <textarea
                value={text}
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder="例如：呢位客想改聽日，邊個跟？"
                className="mt-1 w-full resize-none rounded-2xl border border-line bg-panel-2 px-3 py-2 text-sm"
                data-e2e="wg-share-text"
              />
            </label>
            <p className="mt-2 text-[11px] text-t3">群入面會出一張對話卡（病人名／編號）；冇權睇呢間店嘅同事只會見到「分享咗一個對話」。</p>
            {msg && <div className={`mt-2 text-xs ${msg.ok ? "text-ok-text" : "text-danger-text"}`}>{msg.t}</div>}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy || !gid}
                onClick={() => void share(false)}
                className={`flex-1 rounded-full py-2.5 text-sm font-medium disabled:opacity-50 ${canRelease ? "border border-line bg-panel text-t1 hover:bg-panel-2" : "bg-brand text-panel"}`}
                data-e2e="wg-share-send"
              >
                {busy ? "分享緊…" : "分享"}
              </button>
              {canRelease && (
                <button
                  type="button"
                  disabled={busy || !gid}
                  onClick={() => void share(true)}
                  className="flex-1 rounded-full bg-warn py-2.5 text-sm font-medium text-panel disabled:opacity-50"
                  data-e2e="wg-share-release"
                >
                  分享並放手
                </button>
              )}
            </div>
            {canRelease && (
              <p className="mt-2 text-[11px] leading-relaxed text-t3">
                「放手」= 對話由你名下變返未指派，群入面張卡出「我接」，第一個撳嘅同事接手。銷售保護中嘅病人：保護同佣金唔變，只有負責銷售／被轉交同事接到。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
