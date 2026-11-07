/**
 * ★ cwi-sticker-20261107：貼圖庫
 * GET  → { mine, clinic, canManageClinic }（我的 + 診所貼圖）
 * POST multipart { file, name?, scope: mine|clinic } → 轉 512×512 WebP 加入（診所只限集團管理員）
 *   同一張重複加 → 200 duplicate；每人每分鐘 20 次
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hit } from "@/lib/rate-limit";
import { addSticker, isClinicAdmin, listStickers, STICKER_UPLOAD_MAX } from "@/lib/stickers";
import { stickerError } from "@/lib/stickers-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  return NextResponse.json({ ...(await listStickers(auth.staff.id)), canManageClinic: isClinicAdmin(auth) });
});

export const POST = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  const cl = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(cl) && cl > STICKER_UPLOAD_MAX + 512 * 1024) return NextResponse.json({ error: "TOO_LARGE", message: "檔案太大（最多 8MB）" }, { status: 413 });
  if (!(await hit(`stk:add:${auth.staff.id}`, 20, 60))) return NextResponse.json({ error: "rate_limited", message: "加得太快，等一陣再試" }, { status: 429 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "格式唔啱" }, { status: 400 });
  }
  const file = form.get("file");
  const scope = String(form.get("scope") ?? "mine");
  if (!(file instanceof File)) return NextResponse.json({ error: "bad_request", message: "揀咗圖未？" }, { status: 400 });
  if (scope !== "mine" && scope !== "clinic") return NextResponse.json({ error: "bad_request", message: "範圍唔啱" }, { status: 400 });
  if (file.size > STICKER_UPLOAD_MAX) return NextResponse.json({ error: "TOO_LARGE", message: "檔案太大（最多 8MB）" }, { status: 413 });
  try {
    const r = await addSticker(auth, { buf: Buffer.from(await file.arrayBuffer()), name: form.get("name"), scope });
    return NextResponse.json(r, { status: r.duplicate ? 200 : 201 });
  } catch (e) {
    return stickerError(e);
  }
});
