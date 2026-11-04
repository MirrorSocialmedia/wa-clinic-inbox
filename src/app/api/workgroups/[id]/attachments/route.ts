/**
 * ★ cwi-workgroup-p2-20261105：POST /api/workgroups/[id]/attachments — 工作群發相片／PDF（multipart：file, body?, clientKey?）。
 *
 * 次序：413 content-length → 400 form → 成員／封存（落碟前驗 — 非成員唔准寫檔）→ clientKey 重發（回舊條，唔再落碟）
 *   → 413 >10MB → 415 唔係 JPG／PNG／PDF（magic bytes，唔信 MIME／副檔名）→ 落碟（即加密）→ 寫訊息（失敗即刪檔）。
 * PII：檔名只入 DB + UI，唔入 log／audit。每人每分鐘 20 個。
 */
import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hit } from "@/lib/rate-limit";
import { publishStaffNotify } from "@/lib/notify";
import { pushToStaff } from "@/lib/push";
import { sniffOutboundMedia } from "@/lib/wa/media-sniff";
import { saveMediaFile, mediaDirPreferred } from "@/lib/wa/media";
import { assertCanPost, cleanAttachName, findByClientKey, sendGroupMessage, WG_BODY_MAX } from "@/lib/workgroups";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

const MAX_BYTES = 10 * 1024 * 1024;
const CONTENT_LENGTH_CAP = 10.5 * 1024 * 1024;

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const cl = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(cl) && cl > CONTENT_LENGTH_CAP) return NextResponse.json({ error: "FILE_TOO_LARGE", message: "檔案太大（最多 10MB）" }, { status: 413 });
  if (!(await hit(`wg:attach:${auth.staff.id}`, 20, 60))) return NextResponse.json({ error: "rate_limited", message: "發得太快，等一陣再試" }, { status: 429 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "格式唔啱" }, { status: 400 });
  }
  const file = form.get("file");
  const body = String(form.get("body") ?? "").slice(0, WG_BODY_MAX + 1);
  const clientKey = form.get("clientKey") ? String(form.get("clientKey")).slice(0, 64) : null;
  if (!(file instanceof File)) return NextResponse.json({ error: "bad_request", message: "揀咗檔案未？" }, { status: 400 });
  if (body.trim().length > WG_BODY_MAX) return NextResponse.json({ error: "TOO_LONG", message: `訊息太長（最多 ${WG_BODY_MAX} 字）` }, { status: 400 });
  try {
    await assertCanPost(id, auth.staff.id);
    const prevId = await findByClientKey(id, auth.staff.id, clientKey);
    if (prevId) return NextResponse.json({ messageId: prevId, duplicate: true }, { status: 200 });
  } catch (e) {
    return wgError(e);
  }
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "FILE_TOO_LARGE", message: "檔案太大（最多 10MB）" }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  const kind = sniffOutboundMedia(buf);
  if (!kind) return NextResponse.json({ error: "UNSUPPORTED_TYPE", message: "只支援 JPG／PNG 相片或者 PDF" }, { status: 415 });
  const key = `wg-${randomUUID()}.${kind.ext}`;
  await saveMediaFile(key, buf);
  try {
    const r = await sendGroupMessage(id, auth, {
      body,
      clientKey,
      attachment: { key, name: cleanAttachName(file.name, kind.ext), mime: kind.mime, size: buf.length },
    });
    if (r.duplicate) await unlink(path.join(mediaDirPreferred(), key)).catch(() => undefined);
    for (const sid of r.notify) publishStaffNotify(sid, "", "workgroup:message", { groupId: id, messageId: r.messageId, mention: false });
    publishStaffNotify(auth.staff.id, "", "workgroup:message", { groupId: id, messageId: r.messageId, mention: false });
    for (const sid of r.mentioned) void pushToStaff(sid, { kind: "workgroup", clinicShort: r.groupName.slice(0, 20), conversationId: "", groupId: id });
    return NextResponse.json({ messageId: r.messageId, duplicate: r.duplicate }, { status: r.duplicate ? 200 : 201 });
  } catch (e) {
    await unlink(path.join(mediaDirPreferred(), key)).catch(() => undefined);
    return wgError(e);
  }
});
