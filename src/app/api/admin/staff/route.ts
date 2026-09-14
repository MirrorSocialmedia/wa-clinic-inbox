import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
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
  await requireAdmin(req);
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
  return NextResponse.json(
    users.map((u) => ({
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
  await requireAdmin(req);
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const d = parsed.data;

  // scope 解析：SUPERVISOR 恆 ALL（現行無 scope 概念）；default：STAFF→CLINICS、ADMIN→ALL
  const scopeType: "ALL" | "COMPANY" | "CLINICS" =
    d.role === "SUPERVISOR" ? "ALL" : d.scopeType ?? (d.role === "STAFF" ? "CLINICS" : "ALL");
  const scopeCompanyId = scopeType === "COMPANY" ? d.scopeCompanyId : null;

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
