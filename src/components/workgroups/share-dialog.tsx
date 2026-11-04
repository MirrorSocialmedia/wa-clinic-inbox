"use client";

/**
 * ★ cwi-workgroup-20261104：喺病人對話「⋯ → 分享去工作群」— 揀群 + 打一句 → 群入面出對話卡。
 * 卡只存對話 id；群入面每個人睇到幾多跟返自己權限（冇權嗰間店 → 唔顯示病人資料）。
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

export function ShareToWorkgroupDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
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

  async function share() {
    if (!gid || busy) return;
    setBusy(true);
    setMsg(null);
    key.current ??= newKey();
    try {
      const r = await fetch(`/api/workgroups/${encodeURIComponent(gid)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text, conversationId, clientKey: key.current }),
      });
      const d = (await r.json().catch(() => null)) as { message?: string } | null;
      if (!r.ok) {
        setMsg({ ok: false, t: d?.message ?? "分享失敗" });
        if (r.status < 500 && r.status !== 429) key.current = null;
        return;
      }
      setMsg({ ok: true, t: "已分享" });
      window.setTimeout(onClose, 700);
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
            <button
              type="button"
              disabled={busy || !gid}
              onClick={() => void share()}
              className="mt-3 w-full rounded-full bg-brand py-2.5 text-sm font-medium text-panel disabled:opacity-50"
              data-e2e="wg-share-send"
            >
              {busy ? "分享緊…" : "分享"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
