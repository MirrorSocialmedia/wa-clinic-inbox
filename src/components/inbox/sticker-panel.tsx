"use client";

/**
 * ★ cwi-sticker-20261107：貼圖面板（同 WhatsApp 一樣）
 * - StickerGrid：⭐ 我的貼圖（自己加嘅）＋ 🏥 診所貼圖（全部同事共用）；撳一下即發；「管理」→ 每張出 ✕ 刪
 * - AddStickerDialog：揀相／GIF（或者貼上）→ 靜態圖可以拖動／縮放揀範圍 → 上載（server 轉 512×512 WebP、檢查大細）
 *   診所貼圖只有老闆（集團管理員）見到呢個選項
 * - saveStickerFromMessage：收到嘅貼圖 ⭐ 收藏
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

export interface StickerItem {
  id: string;
  name: string | null;
  animated: boolean;
  url: string;
  scope: "mine" | "clinic";
}

export const STICKERS_CHANGED_EVENT = "wa-inbox:stickers-changed";

export async function saveStickerFromMessage(messageId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetch("/api/stickers/from-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, scope: "mine" }),
    });
    const d = (await r.json().catch(() => null)) as { message?: string; duplicate?: boolean } | null;
    if (!r.ok) return { ok: false, message: d?.message ?? "加唔到" };
    window.dispatchEvent(new Event(STICKERS_CHANGED_EVENT));
    return { ok: true, message: d?.duplicate ? "已經喺我的貼圖" : "已加到我的貼圖 ⭐" };
  } catch {
    return { ok: false, message: "網絡錯誤" };
  }
}

export function StickerGrid({ onPick, disabledReason, compact }: { onPick: (s: StickerItem) => void; disabledReason?: string | null; compact?: boolean }) {
  const [data, setData] = useState<{ mine: StickerItem[]; clinic: StickerItem[]; canManageClinic: boolean } | null>(null);
  const [manage, setManage] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/stickers");
      if (r.ok) setData(await r.json());
    } catch {
      /* 下次再試 */
    }
  }, []);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(STICKERS_CHANGED_EVENT, on);
    return () => window.removeEventListener(STICKERS_CHANGED_EVENT, on);
  }, [load]);

  async function remove(s: StickerItem) {
    setErr(null);
    const r = await fetch(`/api/stickers/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => null);
    if (!r || !r.ok) setErr("刪唔到");
    await load();
  }

  const tile = (s: StickerItem) => (
    <div key={s.id} className="relative">
      <button
        type="button"
        disabled={!!disabledReason || manage}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(s)}
        className="flex aspect-square w-full items-center justify-center rounded-xl border border-line bg-panel p-1 hover:bg-panel-2 disabled:opacity-40"
        title={s.name ?? "貼圖"}
        aria-label={s.name ? `貼圖：${s.name}` : "貼圖"}
        data-e2e="sticker-tile"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={s.url} alt={s.name ?? ""} className="max-h-full max-w-full object-contain" loading="lazy" />
      </button>
      {s.name && <span className="pointer-events-none absolute inset-x-0 bottom-0.5 truncate px-1 text-center text-[9px] text-t2">{s.name}</span>}
      {manage && (s.scope === "mine" || data?.canManageClinic) && (
        <button
          type="button"
          onClick={() => void remove(s)}
          className="absolute -right-1 -top-1 rounded-full bg-danger p-0.5 text-panel shadow"
          aria-label="刪走呢張貼圖"
          data-e2e="sticker-delete"
        >
          <X size={11} strokeWidth={3} />
        </button>
      )}
    </div>
  );

  const cols = compact ? "grid-cols-4" : "grid-cols-5";
  return (
    <div data-e2e="sticker-grid">
      {disabledReason && <div className="mb-1 rounded-lg bg-warn-soft px-2 py-1 text-[11px] text-warn-text">{disabledReason}</div>}
      {err && <div className="mb-1 text-[11px] text-danger-text">{err}</div>}
      <div className={`overflow-y-auto pr-0.5 ${compact ? "max-h-[176px]" : "max-h-[220px]"}`}>
        <div className="mb-1 flex items-center text-[11px] font-semibold text-t3">
          ⭐ 我的貼圖
          <button type="button" onClick={() => setManage((v) => !v)} className="ml-auto rounded-full px-2 py-0.5 text-[11px] font-normal text-t2 hover:bg-panel-2" data-e2e="sticker-manage">
            {manage ? "完成" : "管理"}
          </button>
        </div>
        <div className={`grid ${cols} gap-1.5`}>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex aspect-square w-full items-center justify-center rounded-xl border-2 border-dashed border-brand text-brand-text hover:bg-brand-soft"
            aria-label="加貼圖"
            data-e2e="sticker-add"
          >
            <Plus size={20} strokeWidth={2.5} />
          </button>
          {(data?.mine ?? []).map(tile)}
        </div>
        <div className="mb-1 mt-2 text-[11px] font-semibold text-t3">🏥 診所貼圖</div>
        {data && data.clinic.length === 0 ? (
          <div className="py-2 text-center text-[11px] text-t3">{data.canManageClinic ? "未有 — 撳 ＋ 揀「診所貼圖」加" : "未有（老闆可以加）"}</div>
        ) : (
          <div className={`grid ${cols} gap-1.5`}>{(data?.clinic ?? []).map(tile)}</div>
        )}
      </div>
      {addOpen && (
        <AddStickerDialog
          canManageClinic={!!data?.canManageClinic}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            void load();
            window.dispatchEvent(new Event(STICKERS_CHANGED_EVENT));
          }}
        />
      )}
    </div>
  );
}

const VIEW = 240;

export function AddStickerDialog({ canManageClinic, onClose, onAdded }: { canManageClinic: boolean; onClose: () => void; onAdded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"mine" | "clinic">("mine");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // 動態圖（GIF）／WebP 唔裁（瀏覽器 canvas 會食咗動畫）— server 置中
  const croppable = !!file && /^image\/(jpeg|png)$/.test(file.type);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function pick(f: File | null) {
    setErr(null);
    if (!f) return;
    if (!/^image\/(jpeg|png|gif|webp)$/.test(f.type)) return setErr("只支援 JPG／PNG／GIF／WebP");
    if (f.size > 8 * 1024 * 1024) return setErr("檔案太大（最多 8MB）");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(f);
    setFile(f);
    setPreviewUrl(url);
    setZoom(1);
    setOff({ x: 0, y: 0 });
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = url;
  }

  // 貼上（Ctrl+V 圖片）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (f) pick(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const base = img ? Math.min(VIEW / img.naturalWidth, VIEW / img.naturalHeight) : 1;
  const dw = img ? img.naturalWidth * base * zoom : VIEW;
  const dh = img ? img.naturalHeight * base * zoom : VIEW;
  const left = (VIEW - dw) / 2 + off.x;
  const top = (VIEW - dh) / 2 + off.y;

  async function cropped(): Promise<Blob | null> {
    if (!img || !croppable) return file;
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 512;
    const g = c.getContext("2d");
    if (!g) return file;
    const r = 512 / VIEW;
    g.drawImage(img, left * r, top * r, dw * r, dh * r);
    return new Promise((res) => c.toBlob((b) => res(b), "image/png"));
  }

  async function save() {
    if (!file || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const blob = await cropped();
      if (!blob) return setErr("處理唔到呢張圖");
      const fd = new FormData();
      fd.set("file", blob, croppable ? "sticker.png" : file.name);
      fd.set("name", name);
      fd.set("scope", scope);
      const r = await fetch("/api/stickers", { method: "POST", body: fd });
      const d = (await r.json().catch(() => null)) as { message?: string } | null;
      if (!r.ok) return setErr(d?.message ?? "加唔到");
      onAdded();
    } catch {
      setErr("網絡錯誤，請再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label="加貼圖">
      <button type="button" className="absolute inset-0 bg-black/30" aria-label="關閉" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-t-3xl bg-panel p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl md:rounded-3xl" data-e2e="sticker-add-dialog">
        <div className="mb-3 flex items-center">
          <div className="text-[15px] font-semibold text-t1">加貼圖</div>
          <button type="button" onClick={onClose} className="ml-auto rounded-full p-1 hover:bg-panel-2" aria-label="關閉">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} data-e2e="sticker-file" />
        {!file ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex h-[200px] w-full flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-line text-sm text-t2 hover:bg-panel-2"
          >
            📷 揀相／GIF
            <span className="text-[11px] text-t3">或者直接 Ctrl+V 貼上圖片</span>
          </button>
        ) : (
          <>
            <div
              className="relative mx-auto touch-none overflow-hidden rounded-2xl border-2 border-brand"
              style={{ width: VIEW, height: VIEW, background: "repeating-conic-gradient(#e5e5e5 0 25%, #fff 0 50%) 0 0/16px 16px", cursor: croppable ? "grab" : "default" }}
              onPointerDown={(e) => {
                if (!croppable) return;
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                setOff({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y });
              }}
              onPointerUp={() => (drag.current = null)}
              data-e2e="sticker-crop"
            >
              {previewUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewUrl} alt="" draggable={false} className="pointer-events-none absolute max-w-none select-none" style={{ left, top, width: dw, height: dh }} />
              )}
            </div>
            {croppable ? (
              <label className="mt-2 flex items-center gap-2 text-[11px] text-t2">
                縮放
                <input type="range" min={1} max={4} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="flex-1" />
              </label>
            ) : (
              <div className="mt-2 text-center text-[11px] text-t3">動態圖會原樣置中（唔裁）</div>
            )}
            <div className="mt-1 text-center text-[11px] text-t3">自動轉 512×512 WebP · 靜態 ≤100KB／動態 ≤500KB</div>
            <button type="button" onClick={() => fileRef.current?.click()} className="mx-auto mt-1 block text-[11px] text-brand-text underline">
              換過張圖
            </button>
          </>
        )}
        <label className="mt-3 block text-[12px] text-t2">
          名（方便搵，可以唔寫）
          <input
            value={name}
            maxLength={30}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：收到"
            className="mt-1 w-full rounded-full border border-line bg-panel-2 px-3.5 py-2 text-sm text-t1"
            data-e2e="sticker-name"
          />
        </label>
        {canManageClinic && (
          <div className="mt-2 flex gap-2 text-[12px]">
            {(
              [
                ["mine", "我的貼圖", "只有你自己見到"],
                ["clinic", "診所貼圖", "全部同事都用到"],
              ] as const
            ).map(([k, t, d]) => (
              <button
                key={k}
                type="button"
                onClick={() => setScope(k)}
                className={`flex-1 rounded-2xl border px-3 py-2 text-left ${scope === k ? "border-2 border-brand" : "border-line"}`}
                data-e2e={`sticker-scope-${k}`}
              >
                <div className="font-semibold text-t1">{t}</div>
                <div className="text-[11px] text-t3">{d}</div>
              </button>
            ))}
          </div>
        )}
        {err && <div className="mt-2 text-xs text-danger-text">{err}</div>}
        <button
          type="button"
          disabled={!file || busy}
          onClick={() => void save()}
          className="mt-4 w-full rounded-full bg-brand py-2.5 text-sm font-medium text-panel disabled:opacity-50"
          data-e2e="sticker-save-btn"
        >
          {busy ? "處理緊…" : "加入"}
        </button>
      </div>
    </div>
  );
}
