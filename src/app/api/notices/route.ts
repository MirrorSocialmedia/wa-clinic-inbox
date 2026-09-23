import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, clinicScope, assertClinicAccess, assertCanWriteConversation } from "@/lib/rbac";

/**
 * GET /api/notices — 本店未讀內部通知（AI Workflow T1 A2：媒體/急症升級/...）。
 *   inbox 頂 bell badge 數據源 — 同客戶 unread（conversation.unreadCount）完全分開。
 *   ADMIN：clinicId param 可指店（冇 = 全店）；STAFF：綁自己店（別店 → 403，RBAC 同 conversations）。
 *
 * ★ cwi-final S1-12（audit3 P1-09）：per-staff 已讀 —
 *   LEFT JOIN "StaffNoticeRead"（本 staff 嘅 readAt）判斷「我未讀」；
 *   StaffNotice.readAt/readByStaffId 保留「全店已處理」語義（只 assignee/ADMIN 可設），
 *   唔再決定呢度嘅可見性（A 標已讀唔代表 B 標咗）。
 *
 * PATCH /api/notices — 標已讀：{ ids: string[] }（ids 省 = scope 內全部）。
 *   ① 一律寫 "StaffNoticeRead"（per-staff；本 staff 嘅 bell 即刻清）。
 *   ② **冇 ids 時唔准標 URGENT_ESCALATION**（急症要逐條明確確認 — 批量清會漏確認）。
 *   ③ 全店語義：StaffNotice.readAt/readByStaffId 只有 assignee（對話負責人）或 ADMIN 先會設 —
 *      其他角色嘅 PATCH 只清自己 bell，唔影响其他人。
 */
import { handle } from "@/lib/api-error";

export const dynamic = "force-dynamic";

interface NoticeRow {
  id: string;
  clinicId: string;
  conversationId: string | null;
  kind: string;
  title: string;
  createdAt: Date;
}

/** scope → raw SQL 參數（clinicScope 單一來源；null = 全店） */
async function scopedClinicIdsForRaw(ctx: Awaited<ReturnType<typeof requireAuth>>): Promise<string[]> {
  const scope = clinicScope(ctx);
  return scope.clinicId ? [...scope.clinicId.in] : [];
}

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId");
  if (clinicParam) {
    // ★ cwi-hub-a-20260914（Part A）：scope-aware — 外範圍 clinicId → 403（任何受限角色）
    assertClinicAccess(ctx, clinicParam);
  }
  const scoped = await scopedClinicIdsForRaw(ctx);
  // ★ cwi-final S1-12：per-staff 已讀 — LEFT JOIN StaffNoticeRead（我未讀先見）
  const notices = await prisma.$queryRawUnsafe<NoticeRow[]>(
    `SELECT n."id", n."clinicId", n."conversationId", n."kind", n."title", n."createdAt"
     FROM "StaffNotice" n
     LEFT JOIN "StaffNoticeRead" r ON r."noticeId" = n."id" AND r."staffId" = $1
     WHERE r."staffId" IS NULL
       AND ($2::text[] = '{}' OR n."clinicId" = ANY($2))
       AND ($3::text IS NULL OR n."clinicId" = $3)
     ORDER BY n."createdAt" DESC
     LIMIT 100`,
    ctx.staff.id,
    scoped,
    clinicParam ?? null,
  );
  return NextResponse.json({ notices, count: notices.length });
});

export const PATCH = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  // ★ cwi-final S3-3：SUPERVISOR → 403（SUPERVISOR 嘅已讀係 per-staff 語義（S1-12），唔准寫全店欄 StaffNotice.readAt）
  assertCanWriteConversation(ctx);
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids)
    ? (body!.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200)
    : null;
  if (ids !== null && ids.length === 0) {
    return NextResponse.json({ error: "ids required" }, { status: 400 });
  }

  const scoped = await scopedClinicIdsForRaw(ctx);
  // ★ cwi-final S1-12：冇 ids（批量清）→ 排除 URGENT_ESCALATION（急症要逐條明確確認）
  // 目標通知（scope ∩（ids 如果有）∧（批量 → 非急症））— 只回 id/conversationId/kind
  // （scope 空 = 全店 → 唔入 placeholder，否則 PG 42P18 無法推斷未引用參數類型）
  const typeFilter = scoped.length > 0 ? `"clinicId" = ANY($1::text[])` : `TRUE`;
  const targets: { id: string; conversationId: string | null; kind: string }[] =
    ids === null
      ? await prisma.$queryRawUnsafe<{ id: string; conversationId: string | null; kind: string }[]>(
          `SELECT "id", "conversationId", "kind"
           FROM "StaffNotice"
           WHERE ${typeFilter}
             AND "kind" <> 'URGENT_ESCALATION'`,
          ...(scoped.length > 0 ? [scoped] : []),
        )
      : await prisma.$queryRawUnsafe<{ id: string; conversationId: string | null; kind: string }[]>(
          `SELECT "id", "conversationId", "kind"
           FROM "StaffNotice"
           WHERE "id" = ANY($1::text[])
             AND ${scoped.length > 0 ? `"clinicId" = ANY($2::text[])` : `TRUE`}`,
          ids,
          ...(scoped.length > 0 ? [scoped] : []),
        );
  if (targets.length === 0) return NextResponse.json({ updated: 0, shopCleared: 0 });

  const now = new Date();
  // ① per-staff 已讀（bulk upsert — 冪等；重標只刷新 readAt）
  await prisma.$executeRawUnsafe(
    `INSERT INTO "StaffNoticeRead" ("noticeId", "staffId", "readAt")
     SELECT v, $1, $2
     FROM unnest($3::text[]) AS v
     ON CONFLICT ("noticeId", "staffId") DO UPDATE SET "readAt" = EXCLUDED."readAt"`,
    ctx.staff.id,
    now,
    targets.map((t) => t.id),
  );

  // ② 全店語義（StaffNotice.readAt/readByStaffId）— 只 assignee（對話負責人）/ ADMIN 可設
  let shopCleared = 0;
  let shopIds: string[] = [];
  if (ctx.staff.role === "ADMIN") {
    shopIds = targets.map((t) => t.id);
  } else {
    const convIds = [...new Set(targets.filter((t) => t.conversationId).map((t) => t.conversationId as string))];
    if (convIds.length > 0) {
      const mine = await prisma.conversation.findMany({
        where: { id: { in: convIds }, assigneeId: ctx.staff.id },
        select: { id: true },
      });
      const mineSet = new Set(mine.map((c) => c.id));
      shopIds = targets.filter((t) => t.conversationId && mineSet.has(t.conversationId)).map((t) => t.id);
    }
  }
  if (shopIds.length > 0) {
    // 保留舊語義：只覆寫未全店標記過嘅行（第一個標記人留底）
    const res = await prisma.staffNotice.updateMany({
      where: { id: { in: shopIds }, readAt: null },
      data: { readByStaffId: ctx.staff.id, readAt: now },
    });
    shopCleared = res.count;
  }

  return NextResponse.json({ updated: targets.length, shopCleared });
});
