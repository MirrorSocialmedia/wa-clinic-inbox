import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth, assertClinicAccess, scopedClinicSet, type AuthContext } from "@/lib/rbac";
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
  const ctx: AuthContext = await requireAuth(req);
  const { staff, res } = ctx;
  const cookie = res.headers.get("set-cookie") ?? "";

  const body = (await req.json().catch(() => null)) as { clinicId?: unknown; delaySec?: unknown } | null;
  // ★ cwi-notify-a4：延遲測試（1–30 秒）— 撳完即刻閂 app／鎖機，驗證「背景」真係響唔響
  //   （即時測試時 app 仲喺前台，部分系統前台唔出橫額 → 測唔到真實情況）。
  const delaySec =
    typeof body?.delaySec === "number" && Number.isInteger(body.delaySec) && body.delaySec >= 1 && body.delaySec <= 30
      ? body.delaySec
      : 0;
  let clinicId: string | null = null;
  if (typeof body?.clinicId === "string" && body.clinicId.length > 0) {
    // ★ cwi-hub-a-20260914（Part A）：scope-aware — 外範圍 clinicId → 403（任何受限角色）
    assertClinicAccess(ctx, body.clinicId);
    clinicId = body.clinicId;
  } else {
    // 無 clinicId：受限角色只有單一 clinic 先自動填（現行 STAFF 單店行為）；
    // 多 clinic 受限角色必須明確傳 clinicId（避免猜錯店）
    const set = scopedClinicSet(ctx);
    if (set !== null && set.length === 1) clinicId = set[0];
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
  const testPayload = { kind: "notice" as const, clinicShort: clinic.code, conversationId: "", test: true };
  if (delaySec > 0) {
    // fire-and-forget：結果睇「推送診斷」（lastOkAt = 推送服務收貨 / lastReceivedAt = 部機收到）
    setTimeout(() => {
      void pushToStaffResult(staff.id, testPayload);
    }, delaySec * 1000);
    return Response.json(
      { ok: true, result: "scheduled", delaySec, clinicId, clinicShort: clinic.code },
      { status: 200, headers: { "Set-Cookie": cookie } }
    );
  }
  const r = await pushToStaffResult(staff.id, testPayload);
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
