import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAdmin, requireGlobalAdmin, assertClinicAccess, invalidateClinicScopeCache } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";

/**
 * /api/admin/clinics/[id] — ADMIN-only（RBAC fail-closed：STAFF 一律 403，E2E T24 實測）。
 *
 * GET   : 單店詳情（含 aiMode）
 * PUT   : 更新（code/name/waPhoneNumberId/waDisplayNumber/greetingConfig/aiMode）
 * PATCH : 部分更新（同 PUT — Phase 2b UI 用 PATCH 切 aiMode）
 * DELETE: 刪除 — 有對話/聯絡人/員工掛住 → 409（fail-closed，唔做 cascade 刪病人資料）
 */
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  code: z.string().min(1).max(16).optional(),
  name: z.string().min(1).max(100).optional(),
  waPhoneNumberId: z.string().min(1).max(64).optional(),
  waDisplayNumber: z.string().min(1).max(32).optional(),
  // 注意：冇 default — PATCH 部分更新時，未傳嘅字段唔好被 default 覆蓋（e.g. 淨系改 aiMode 唔可清掉 greetingConfig）
  greetingConfig: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
  // Phase 2b：逐舖 AI 模式（DRAFT=預設只出建議 / AUTO=AI 可直接自動發）
  aiMode: z.enum(["DRAFT", "AUTO"]).optional(),
  // ★ cwi-hub-a-20260914：公司歸屬改動（reassign — 改後 COMPANY 範圍即時跟）
  companyId: z.string().min(1).max(64).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

async function updateClinic(req: NextRequest, ctx: Ctx) {
  // ★ cwi-final S3-1：店寫操作 = 集團級（公司歸屬／分流 key）— 只限 global admin
  await requireGlobalAdmin(req);
  const { id } = await ctx.params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (k === "greetingConfig") {
      data[k] = v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
    } else if (v !== undefined) {
      data[k] = v;
    }
  }
  // ★ cwi-hub-a：公司存在性驗證
  if (typeof data.companyId === "string") {
    const company = await prisma.company.findUnique({ where: { id: data.companyId } });
    if (!company) return NextResponse.json({ error: "company not found" }, { status: 400 });
  }
  // ★ cwi-final S3-1：關鍵欄改動（companyId / waPhoneNumberId / waBusinessAccountId / code）
  //   → 就算 global admin 都要 AuditLog CLINIC_CRITICAL_CHANGE（meta 記舊值新值）+ Alert(HIGH)
  const criticalKeys = ["companyId", "waPhoneNumberId", "waBusinessAccountId", "code"] as const;
  const changedCritical: Record<string, { old: unknown; new: unknown }> = {};
  if (criticalKeys.some((k) => k in data)) {
    const oldRow = await prisma.clinic.findUnique({ where: { id } });
    if (!oldRow) return NextResponse.json({ error: "not found" }, { status: 404 });
    for (const k of criticalKeys) {
      if (k in data && data[k] !== oldRow[k]) changedCritical[k] = { old: oldRow[k], new: data[k] };
    }
  }
  const clinic = await prisma.clinic.update({ where: { id }, data });
  if (Object.keys(changedCritical).length > 0) {
    await prisma.auditLog
      .create({
        data: {
          staffId: null,
          action: "CLINIC_CRITICAL_CHANGE",
          entity: "Clinic",
          entityId: id,
          meta: { fields: changedCritical } as object,
        },
      })
      .catch(() => undefined);
    await prisma.alert
      .create({
        data: {
          type: "clinic_critical_change",
          severity: "HIGH",
          clinicId: id,
          clinicCode: clinic.code,
          detail: { fields: Object.keys(changedCritical) } as object,
        },
      })
      .catch(() => undefined);
  }
  // ★ cwi-hub-a：公司歸屬改動 → COMPANY 範圍集合即時失效重算
  invalidateClinicScopeCache();
  return NextResponse.json(clinic);
}

export const PUT = handle(updateClinic);
export const PATCH = handle(updateClinic);

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const adminCtx = await requireAdmin(req);
  const { id } = await ctx.params;
  // ★ cwi-final S3-1：scope 核對（scoped ADMIN 唔可以睇外店；SUPERVISOR/ALL = 全店）
  assertClinicAccess(adminCtx, id);
  const clinic = await prisma.clinic.findUnique({
    where: { id },
    include: { company: { select: { id: true, code: true, name: true } } },
  });
  if (!clinic) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(clinic);
});

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  // ★ cwi-final S3-1：删店 = 集團級操作 — 只限 global admin
  await requireGlobalAdmin(req);
  const { id } = await ctx.params;

  const [conversations, contacts, staff] = await Promise.all([
    prisma.conversation.count({ where: { clinicId: id } }),
    prisma.contact.count({ where: { clinicId: id } }),
    prisma.staffUser.count({ where: { clinicId: id } }),
  ]);
  if (conversations > 0 || contacts > 0 || staff > 0) {
    return NextResponse.json(
      {
        error: "clinic has dependent data",
        detail: { conversations, contacts, staff },
        hint: "先搬走/停用該店嘅對話、聯絡人同員工，先可以刪除",
      },
      { status: 409 }
    );
  }
  await prisma.clinic.delete({ where: { id } });
  // ★ cwi-hub-a：诊所刪除 → 範圍集合即時失效
  invalidateClinicScopeCache();
  return NextResponse.json({ ok: true });
});
