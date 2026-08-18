import { type NextRequest } from "next/server";
import { getSession, type SessionData } from "@/lib/session";

/**
 * WA Clinic Inbox — RBAC 基礎（框架 MD D10 / §6.4）
 *
 * 權限模型：
 * - ADMIN  → 跨店（clinicId = null，可睇全部店）
 * - STAFF  → 只自己店（clinicId 硬性綁定；每條 query 都要帶 clinicId = session.clinicId，
 *            唔靠前端收埋）
 *
 * 用法（App Router route handler）：
 *   const { staff, clinicId, res } = await requireAuth(req);
 *   const rows = await prisma.conversation.findMany({ where: clinicScope({ role, clinicId }) });
 *   ...
 *   return next(res)  // 或將 res 嘅 set-cookie header 帶落自己個 response
 *
 * 例外（唔經 RBAC）：/api/wa/webhook（Meta 簽名驗證）、/api/flows/endpoint（RSA 加密驗證）、
 * /healthz（monitoring）。
 *
 * Phase 1 TODO：requireAuth 落 DB 核 StaffUser.active（session 係 snapshot，
 * 停用帳號要即時生效 — 呢度先加 prisma 查詢）。
 */

export interface StaffInfo {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "STAFF";
}

export interface AuthContext {
  staff: StaffInfo;
  /** STAFF = 綁定店；ADMIN = null（跨店） */
  clinicId: string | null;
  /** 必需要將呢個 response（或其 set-cookie header）帶返畀 client */
  res: Awaited<ReturnType<typeof getSession>>["res"];
}

export class RbacError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "RbacError";
  }
}

/**
 * 要求已登入（ADMIN 或 STAFF 都過）。
 * 未登入 / session 无效 → 401。
 */
export async function requireAuth(req: NextRequest): Promise<AuthContext> {
  const { data, res } = await getSession(req);
  if (!data) {
    throw new RbacError(401, "unauthorized");
  }
  return toContext(data, res);
}

/**
 * 要求 ADMIN。未登入 → 401；STAFF → 403。
 */
export async function requireAdmin(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  if (ctx.staff.role !== "ADMIN") {
    throw new RbacError(403, "admin required");
  }
  return ctx;
}

/**
 * STAFF 硬性綁定 clinicId 嘅 query scope helper：
 *   where: { ...clinicScope(ctx) }
 * ADMIN → {}（跨店）；STAFF → { clinicId }（只自己店）。
 * 所有按店過濾嘅 Prisma query 都必過呢個，唔好手寫 clinicId 條件。
 */
export function clinicScope(ctx: {
  staff: { role: "ADMIN" | "STAFF" };
  clinicId: string | null;
}): { clinicId?: string } {
  if (ctx.staff.role === "STAFF") {
    if (!ctx.clinicId) {
      // STAFF 冇 clinicId = 壞 session，直接擋
      throw new RbacError(401, "staff session missing clinicId");
    }
    return { clinicId: ctx.clinicId };
  }
  return {};
}

/** 單店訪問檢查（e.g. GET /api/conversations/[id]）：STAFF 只准入自己店嘅 entity。 */
export function assertClinicAccess(
  ctx: Pick<AuthContext, "staff" | "clinicId">,
  targetClinicId: string
): void {
  if (ctx.staff.role === "STAFF" && ctx.clinicId !== targetClinicId) {
    throw new RbacError(403, "cross-clinic access denied");
  }
}

function toContext(data: SessionData, res: AuthContext["res"]): AuthContext {
  // Fail-closed：role 必須係已知值（防壞 session / role 字串注入）
  if (data.role !== "ADMIN" && data.role !== "STAFF") {
    throw new RbacError(401, "invalid session role");
  }
  // Fail-closed：STAFF 必須有 clinicId — 冇 clinicId 嘅 STAFF context 會令 query 變成無 scope（跨店讀），
  // 所以喺最底層呢度就擋死，唔靠每個 route 記得調 clinicScope。
  if (data.role === "STAFF" && !data.clinicId) {
    throw new RbacError(401, "staff session missing clinicId");
  }
  return {
    staff: {
      id: data.staffId,
      email: data.email,
      name: data.name,
      role: data.role,
    },
    clinicId: data.clinicId,
    res,
  };
}
