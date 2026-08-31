import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, clinicScope } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/notices — 本店未讀內部通知（AI Workflow T1 A2：媒體/急症升級/...）。
 *   inbox 頂 bell badge 數據源 — 同客戶 unread（conversation.unreadCount）完全分開。
 *   ADMIN：clinicId param 可指店（冇 = 全店）；STAFF：綁自己店（別店 → 403，RBAC 同 conversations）。
 * PATCH /api/notices — 標已讀：{ ids: string[] }（ids 省 = scope 內全部）。
 *   寫 readByStaffId + readAt（retention purge 依 readAt 清理 90 天前已讀）。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const scope = clinicScope(ctx);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId");
  const where: Record<string, unknown> = { ...scope, readAt: null };
  if (clinicParam) {
    // STAFF 稔非自己綁定店嘅 clinicId → 403（RBAC 鐵律；cwi-h6 多店：集合檢查）
    if (ctx.staff.role === "STAFF" && !ctx.clinicIds.includes(clinicParam)) {
      return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
    }
    where.clinicId = clinicParam;
  }
  const notices = await prisma.staffNotice.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      clinicId: true,
      conversationId: true,
      kind: true,
      title: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ notices, count: notices.length });
});

export const PATCH = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const scope = clinicScope(ctx);
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids)
    ? (body!.ids as unknown[]).filter((x): x is string => typeof x === "string")
    : null;
  const where: Record<string, unknown> = { ...scope, readAt: null };
  if (ids !== null) {
    if (ids.length === 0) {
      return NextResponse.json({ error: "ids required" }, { status: 400 });
    }
    where.id = { in: ids };
  }
  const res = await prisma.staffNotice.updateMany({
    where,
    data: { readByStaffId: ctx.staff.id, readAt: new Date() },
  });
  return NextResponse.json({ updated: res.count });
});
