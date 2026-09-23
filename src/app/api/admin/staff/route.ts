import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import { requireAdmin, resolveClinicIds, type ScopeType } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";

/**
 * /api/admin/staff — ADMIN-only（員工 CRUD，Phase 1 目標 2）。
 *
 * GET  : 列表（email/name/role/active + ★ cwi-hub-a scope：scopeType/scopeCompanyId/companyCode/clinicCodes）
 * POST : 建立（STAFF 必給 clinicId 同 password；ADMIN / SUPERVISOR clinicId = null）
 *
 * ★ cwi-hub-a-20260914（Part A）：公司層範圍（MD A.3）
 *   scopeType = ALL（全集團）| COMPANY（某公司 — 公司加店自動包含 A-4）| CLINICS（指定診所 StaffClinic，可跨公司）
 *   - SUPERVISOR 現行無 scope 概念 → 一律寫 ALL（全店唯讀語義唔變）。
 *   - CLINICS 模式任何角色都要 StaffClinic 行（≥1）— routing group 綁定驗證 + login session snapshot 都依賴佢。
 *   - 舊 session（JWT 無 scopeType）fallback：ADMIN→ALL、STAFF→CLINICS（MD A.2，rbac.sessionScopeType）。
 */
export const dynamic = "force-dynamic";

const scopeTypeSchema = z.enum(["ALL", "COMPANY", "CLINICS"]);

const createSchema = z
  .object({
    email: z.string().email().max(200),
    name: z.string().min(1).max(100),
    role: z.enum(["ADMIN", "STAFF", "SUPERVISOR"]),
    clinicId: z.string().min(1).max(64).nullable().optional(),
    scopeType: scopeTypeSchema.optional(),
    scopeCompanyId: z.string().min(1).max(64).nullable().optional(),
    /** ★ cwi-hub-a：CLINICS 模式嘅診所集合（可跨公司；頭一個 = 主店 isPrimary） */
    clinicIds: z.array(z.string().min(1).max(64)).max(50).optional(),
    password: z.string().min(8).max(128),
    active: z.boolean().optional().default(true),
  })
  .refine((d) => d.scopeType !== "COMPANY" || Boolean(d.scopeCompanyId), {
    message: "scopeType=COMPANY 必須揀公司",
    path: ["scopeCompanyId"],
  })
  // SUPERVISOR 現行全店唯讀（ clinicId 必 null）— 唔變
  .refine((d) => d.role !== "SUPERVISOR" || d.clinicId === null || d.clinicId === undefined, {
    message: "SUPERVISOR clinicId 必須為 null（全店）",
    path: ["clinicId"],
  });

/** 列表嘅 scope 摘要（MD A.3 列表「診所」欄：全集團 / `A 菁薈（1）` / `TY, TKW`） */
function scopeSummaryFor(
  u: { id: string; role: string; scopeType: string; scopeCompanyId: string | null },
  staffClinics: Map<string, string[]>,
  companyClinicCodes: Map<string, string[]>,
  companyCodeMap: Map<string, string>,
  companyNameMap: Map<string, string>,
  companyClinicCount: Map<string, number>,
  clinicCodeMap: Map<string, string>
) {
  const scopeType = u.role === "SUPERVISOR" ? "ALL" : u.scopeType;
  const clinicIds = scopeType === "CLINICS" ? (staffClinics.get(u.id) ?? []) : [];
  let clinicCodes: string[] = [];
  if (scopeType === "CLINICS") {
    clinicCodes = clinicIds.map((cid) => clinicCodeMap.get(cid) ?? "");
  } else if (scopeType === "COMPANY" && u.scopeCompanyId) {
    clinicCodes = companyClinicCodes.get(u.scopeCompanyId) ?? [];
  }
  return {
    scopeType,
    scopeCompanyId: scopeType === "COMPANY" ? u.scopeCompanyId : null,
    companyCode: scopeType === "COMPANY" && u.scopeCompanyId ? (companyCodeMap.get(u.scopeCompanyId) ?? null) : null,
    companyName: scopeType === "COMPANY" && u.scopeCompanyId ? (companyNameMap.get(u.scopeCompanyId) ?? null) : null,
    companyClinicCount: scopeType === "COMPANY" && u.scopeCompanyId ? (companyClinicCount.get(u.scopeCompanyId) ?? 0) : null,
    // 原始 id 集合（UI openEdit 還原 CLINICS 多選用）
    clinicIds: scopeType === "CLINICS" ? clinicIds : [],
    clinicCodes: clinicCodes.filter(Boolean),
  };
}

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const [users, clinics, staffClinicRows, companies, companyClinicRows] = await Promise.all([
    prisma.staffUser.findMany({
      orderBy: [{ role: "asc" }, { email: "asc" }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        clinicId: true,
        active: true,
        scopeType: true,
        scopeCompanyId: true,
      },
    }),
    prisma.clinic.findMany({ select: { id: true, code: true, companyId: true } }),
    prisma.staffClinic.findMany({ select: { staffId: true, clinicId: true } }),
    prisma.company.findMany({ select: { id: true, code: true, name: true } }),
    prisma.clinic.findMany({ where: { companyId: { not: null } }, select: { id: true, code: true, companyId: true } }),
  ]);
  const clinicCodeMap = new Map(clinics.map((c) => [c.id, c.code]));
  const companyCodeMap = new Map(companies.map((c) => [c.id, c.code]));
  const companyNameMap = new Map(companies.map((c) => [c.id, c.name]));
  const companyClinicCodes = new Map<string, string[]>();
  for (const row of companyClinicRows) {
    if (!row.companyId) continue;
    const arr = companyClinicCodes.get(row.companyId) ?? [];
    arr.push(row.code);
    companyClinicCodes.set(row.companyId, arr);
  }
  const companyClinicCount = new Map([...companyClinicCodes].map(([k, v]) => [k, v.length]));
  // staffClinics：staffId → clinicId[]（StaffClinic 行順序）
  const staffClinics = new Map<string, string[]>();
  for (const row of staffClinicRows) {
    const arr = staffClinics.get(row.staffId) ?? [];
    arr.push(row.clinicId);
    staffClinics.set(row.staffId, arr);
  }
  // ★ cwi-final S3-1：非 global ADMIN 只見到「目標員工範圍 ⊆ 我範圍」嘅 STAFF
  //   （用 resolveClinicIds 逐個計 — 員工數少，可以 in-memory filter；spec 表格 S3-1）；
  //   ADMIN／SUPERVISOR 目標唔回（只有集團管理員可以管理佢哋）。
  let visibleUsers = users;
  // ★ cwi-final S3-1：只限 scoped ADMIN（role=ADMIN 且 scope ≠ ALL）；SUPERVISOR（全店唯讀語義）維持現行。
  if (ctx.staff.role === "ADMIN" && ctx.scopeType !== "ALL") {
    const callerSet = new Set(ctx.scopedClinicIds);
    const visible: typeof users = [];
    for (const u of users) {
      if (u.role !== "STAFF") continue; // ADMIN/SUPERVISOR 目標唔回
      // scopeType null = 舊數據 = CLINICS（同 sessionScopeType fallback）
      const targetIds = await resolveClinicIds({
        scopeType: (u.scopeType ?? "CLINICS") as ScopeType,
        scopeCompanyId: u.scopeCompanyId,
        staffClinicIds: staffClinics.get(u.id) ?? [],
      });
      // fail-closed：空集合 / 任何店超出我範圍 → 唔回
      if (targetIds.length > 0 && targetIds.every((c) => callerSet.has(c))) visible.push(u);
    }
    visibleUsers = visible;
  }
  return NextResponse.json(
    visibleUsers.map((u) => ({
      ...u,
      clinicCode: u.clinicId ? (clinicCodeMap.get(u.clinicId) ?? null) : null,
      ...scopeSummaryFor(
        u,
        staffClinics,
        companyClinicCodes,
        companyCodeMap,
        companyNameMap,
        companyClinicCount,
        clinicCodeMap
      ),
    }))
  );
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const d = parsed.data;

  // ★ cwi-final S3-1：scoped ADMIN（role=ADMIN 且 scope ≠ ALL）建立限制；SUPERVISOR 維持現行。
  //   - 只可以建 STAFF（ADMIN / SUPERVISOR → 403）
  //   - 目標 scope 唔可以係 ALL（集團權限只有集團管理員可給）
  //   - CLINICS 模式：目標診所集合 ⊆ 自己 scope
  //   - COMPANY 模式：只可以係自己 scope 嘅同一間公司
  if (ctx.staff.role === "ADMIN" && ctx.scopeType !== "ALL") {
    if (d.role !== "STAFF") {
      return NextResponse.json({ error: "forbidden", message: "只可以建立 STAFF（ADMIN/SUPERVISOR 需要集團管理員）" }, { status: 403 });
    }
    const reqScopeType: "ALL" | "COMPANY" | "CLINICS" = d.scopeType ?? "CLINICS";
    if (reqScopeType === "ALL") {
      return NextResponse.json({ error: "forbidden", message: "唔可以建立 ALL 範圍嘅帳號" }, { status: 403 });
    }
    if (reqScopeType === "COMPANY") {
      const callerRow = await prisma.staffUser.findUnique({ where: { id: ctx.staff.id }, select: { scopeCompanyId: true } });
      if (callerRow?.scopeCompanyId !== d.scopeCompanyId) {
        return NextResponse.json({ error: "forbidden", message: "只可以建立自己公司內嘅帳號" }, { status: 403 });
      }
    } else {
      const callerSet = new Set(ctx.scopedClinicIds);
      const clinicList = [...new Set([...(d.clinicIds ?? []), ...(d.clinicId ? [d.clinicId] : [])])];
      if (clinicList.length === 0 || !clinicList.every((c) => callerSet.has(c))) {
        return NextResponse.json({ error: "forbidden", message: "診所集合超出自己 scope" }, { status: 403 });
      }
    }
  }

  // scope 解析：SUPERVISOR 恆 ALL（現行無 scope 概念）；default：STAFF→CLINICS、ADMIN→ALL
  const scopeType: "ALL" | "COMPANY" | "CLINICS" =
    d.role === "SUPERVISOR" ? "ALL" : d.scopeType ?? (d.role === "STAFF" ? "CLINICS" : "ALL");
  const scopeCompanyId = scopeType === "COMPANY" ? d.scopeCompanyId : null;

  // ★ cwi-final S3-1 步驟 0（臨時守衛 — spec 碼逐字）：ALLOW_SCOPED_ADMIN 未開 → scoped ADMIN 一律 400
  const effectiveRole = d.role;
  const effectiveScopeType = scopeType;
  if (effectiveRole === "ADMIN" && effectiveScopeType !== "ALL" && process.env.ALLOW_SCOPED_ADMIN !== "1") {
    return NextResponse.json({ error: "SCOPED_ADMIN_DISABLED", message: "公司／指定診所範圍 ADMIN 要等權限修復（cwi-final S3-1）上線先開" }, { status: 400 });
  }

  // CLINICS 模式嘅有效診所集合（clinicIds + 舊 clinicId 欄合併去重）
  let clinicList: string[] = [];
  if (scopeType === "CLINICS") {
    clinicList = [...new Set([...(d.clinicIds ?? []), ...(d.clinicId ? [d.clinicId] : [])])];
    if (clinicList.length === 0) {
      return NextResponse.json({ error: "CLINICS 範圍必須揀最少一間診所" }, { status: 400 });
    }
  }

  if (scopeCompanyId) {
    const company = await prisma.company.findUnique({ where: { id: scopeCompanyId } });
    if (!company) return NextResponse.json({ error: "company not found" }, { status: 400 });
  }
  if (clinicList.length > 0) {
    const found = await prisma.clinic.findMany({ where: { id: { in: clinicList } }, select: { id: true } });
    if (found.length !== clinicList.length) {
      return NextResponse.json({ error: "clinic not found" }, { status: 400 });
    }
  }

  const passwordHash = await argon2.hash(d.password);
  const primaryClinicId = scopeType === "CLINICS" && clinicList.length > 0 ? clinicList[0] : null;
  const user = await prisma.staffUser.create({
    data: {
      email: d.email,
      name: d.name,
      role: d.role,
      clinicId: primaryClinicId,
      scopeType,
      scopeCompanyId,
      active: d.active,
      passwordHash,
    },
  });
  // CLINICS 模式（任何角色）→ StaffClinic 行（routing group 綁定驗證 + login snapshot 都依賴）
  if (scopeType === "CLINICS") {
    await prisma.staffClinic.createMany({
      data: clinicList.map((cid, i) => ({ staffId: user.id, clinicId: cid, isPrimary: i === 0 })),
    });
  }
  const { passwordHash: _ph, ...safe } = user;
  return NextResponse.json(safe, { status: 201 });
});
