import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import prisma from "@/lib/prisma";
import { pushToStaffResult, isClinicMutedForStaff } from "@/lib/push";

/**
 * POST /api/push/test — 「發測試通知」（cwi-notify-fix-20260907 F-6）：
 * 對自己行完整 pushToStaff（同真通知同一條路 — 唔係模擬）→ 四種結果：
 * - pushed          已推送 N 部裝置
 * - no-subscription 冇裝置訂閱（permission 未授權 / 未 subscribe / 登出清咗）
 * - muted           呢間店被你靜音咗（真通知會濾走你 — UI 帶 [解除]）
 * - failed          推送失敗：<原因>（endpoint 500 / 網絡 / 410 等）
 *
 * 附帶：vapid-off（server Web Push 未配置 — 運維問題，client 照可以經 socket 收通知）。
 *
 * body: { clinicId?: string } — 缺省 = STAFF 唯一綁定店；ADMIN 必傳。
 * STAFF 傳別店 clinicId → 403（RBAC 鐵律）。
 *
 * ★ PII 鐵律：payload 只有 kind/clinicShort/conversationId（= ""）— 同真 push 一致。
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const { staff, res, clinicIds } = await requireAuth(req);
  const cookie = res.headers.get("set-cookie") ?? "";

  const body = (await req.json().catch(() => null)) as { clinicId?: unknown } | null;
  let clinicId: string | null = null;
  if (typeof body?.clinicId === "string" && body.clinicId.length > 0) {
    if (staff.role === "STAFF" && !clinicIds.includes(body.clinicId)) {
      return Response.json({ error: "no access to clinic" }, { status: 403, headers: { "Set-Cookie": cookie } });
    }
    clinicId = body.clinicId;
  } else if (staff.role === "STAFF" && clinicIds.length === 1) {
    clinicId = clinicIds[0];
  }
  if (!clinicId) {
    return Response.json({ error: "clinicId required" }, { status: 400, headers: { "Set-Cookie": cookie } });
  }

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { code: true } });
  if (!clinic?.code) {
    return Response.json({ error: "clinic not found" }, { status: 404, headers: { "Set-Cookie": cookie } });
  }

  // 靜音先攔（含 F-3 自我修復語義）— 真通知會喺收件人解析時濾走你
  if (await isClinicMutedForStaff(staff.id, clinicId)) {
    return Response.json(
      { ok: true, result: "muted", clinicId, clinicShort: clinic.code },
      { status: 200, headers: { "Set-Cookie": cookie } }
    );
  }

  // 同真通知同一條路（pushToStaff → webpush.sendNotification 逐 subscription）
  const r = await pushToStaffResult(staff.id, { kind: "notice", clinicShort: clinic.code, conversationId: "" });
  const base = { ok: true as const, clinicId, clinicShort: clinic.code };
  if (!r.vapidReady) {
    return Response.json({ ...base, result: "vapid-off" }, { status: 200, headers: { "Set-Cookie": cookie } });
  }
  if (r.subscriptions === 0) {
    return Response.json({ ...base, result: "no-subscription" }, { status: 200, headers: { "Set-Cookie": cookie } });
  }
  if (r.sent > 0) {
    return Response.json({ ...base, result: "pushed", count: r.sent }, { status: 200, headers: { "Set-Cookie": cookie } });
  }
  return Response.json(
    { ...base, result: "failed", reason: r.failures[0] ?? "unknown" },
    { status: 200, headers: { "Set-Cookie": cookie } }
  );
});
