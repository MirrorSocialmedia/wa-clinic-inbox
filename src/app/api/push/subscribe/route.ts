import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import prisma from "@/lib/prisma";
import log from "@/lib/log";

/**
 * POST /api/push/subscribe — 存/更新 subscription（upsert by endpoint）綁登入 staff。
 * body: { endpoint: string, keys: { p256dh: string, auth: string }, userAgent?: string }
 *
 * endpoint 係 per-device/browser 唯一（push 標準）— 同一台瀏覽器登唔同一人時，
 * 登出 route 會先刪 row（共用前台機鐵律），所以唔需要 staff+endpoint 複合 unique。
 *
 * S3-7：endpoint 必喺 vendor allowlist（fcm/apple/mozilla/windows，fail-closed —
 * 防被劫持 admin 註冊任意出網 URL 做 push endpoint = 資料外洩/SSRF 通道）；
 * endpoint 已綁另一 staff → 刪舊綁定 + AuditLog PUSH_REBIND（rebind 可審計）。
 *
 * e2e 例外：WA_MOCK=1（dev/e2e only）准 loopback endpoint（e2e-push.ts 嘅本地 TLS
 * mock receiver — 真 vendor 唔會應 test push）；production（WA_MOCK≠1）嚴格 fail-closed。
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const { staff, res } = await requireAuth(req);
  const cookie = res.headers.get("set-cookie") ?? "";

  const body = (await req.json().catch(() => null)) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    userAgent?: string;
  } | null;

  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || !p256dh || !auth) {
    return Response.json({ error: "missing fields" }, { status: 400, headers: { "Set-Cookie": cookie } });
  }

  const userAgent = typeof body?.userAgent === "string" ? body.userAgent.slice(0, 300) : null;
  // S3-7：vendor allowlist（fail-closed；spec 逐字 regex — 只准 4 大 web-push vendor 域）
  const ALLOWED = [
    /^https:\/\/fcm\.googleapis\.com\//,
    /^https:\/\/[a-z0-9.-]*\.push\.apple\.com\//,
    /^https:\/\/updates\.push\.services\.mozilla\.com\//,
    /^https:\/\/[a-z0-9.-]*\.notify\.windows\.com\//,
  ];
  // e2e 例外（WA_MOCK=1 only）：loopback = e2e-push.ts 本地 TLS mock receiver（見 docblock）
  const loopbackAllowed =
    process.env.WA_MOCK === "1" && /^https:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(endpoint);
  if (!loopbackAllowed && !ALLOWED.some((r) => r.test(endpoint))) {
    log.warn({ staffId: staff.id }, "push: endpoint 唔喺 vendor allowlist — 拒");
    return Response.json({ error: "endpoint not allowed" }, { status: 400, headers: { "Set-Cookie": cookie } });
  }
  // S3-7：endpoint 已綁另一 staff → 刪舊綁定 + AuditLog PUSH_REBIND（rebind 可審計）
  const existing = await prisma.pushSubscription.findUnique({ where: { endpoint } });
  if (existing && existing.staffId !== staff.id) {
    await prisma.pushSubscription.delete({ where: { endpoint } });
    await prisma.pushSubscription.create({ data: { staffId: staff.id, endpoint, p256dh, auth, userAgent } });
    await prisma.auditLog.create({
      data: {
        staffId: staff.id,
        action: "PUSH_REBIND",
        entity: "PushSubscription",
        entityId: endpoint,
        meta: { previousStaffId: existing.staffId },
      },
    });
    log.info({ staffId: staff.id }, "push: endpoint rebind — 舊綁定已刪 + PUSH_REBIND 審計");
  } else {
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { staffId: staff.id, endpoint, p256dh, auth, userAgent },
      update: {
        // 同一 staff 換 browser/refresh keys → 原樣更新
        staffId: staff.id,
        p256dh,
        auth,
        userAgent,
      },
    });
    log.info({ staffId: staff.id }, "push: subscription 已存/更新");
  }
  return Response.json({ ok: true }, { status: 200, headers: { "Set-Cookie": cookie } });
});
