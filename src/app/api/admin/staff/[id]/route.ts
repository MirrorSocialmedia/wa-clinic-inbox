import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import { requireAdmin, invalidateActiveCache, invalidateStaffSessions } from "@/lib/rbac";
import { publishControl, publishNotify } from "@/lib/notify";
import log from "@/lib/log";
import { handle, toResponse } from "@/lib/api-error";

/**
 * /api/admin/staff/[id] — ADMIN-only。
 *
 * PUT : 更新 name/role/clinicId/active + 任意 password reset（newPassword）
 *       - STAFF 必須有 clinicId（fail-closed：唔會製造跨店帳號）
 *       - 防止鎖死：最後一個 active ADMIN 唔可以降權/停用
 *       - 唔可以 DELETE 自己；自己停用 → 擋（自鎖死保護）
 *       - ★ P0-3：停用（active true→false）→ 即時失效 requireAuth cache + 強制斷該 staff
 *         所有已連 socket（disconnectSockets）— 離職員工即刻失去存取，唔使等 session 到期
 *       - ★ C-3 尾批：password reset → 踢晒該 staff 所有舊 session（loginAt cutoff —
 *         本地 401 + control broadcast 斷已連 socket）— 舊 cookie 唔可以繼續用
 * DELETE: 硬刪 — 有 Message.sentByStaffId / Conversation.assigneeId 引用 → 409
 *         （改用 active=false 停用）
 */
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(["ADMIN", "STAFF", "SUPERVISOR"]).optional(),
  clinicId: z.string().min(1).max(64).nullable().optional(),
  // ★ cwi-hub-a-20260914（Part A）：公司層範圍（MD A.3）
  scopeType: z.enum(["ALL", "COMPANY", "CLINICS"]).optional(),
  scopeCompanyId: z.string().min(1).max(64).nullable().optional(),
  /** CLINICS 模式診所集合（replace 語義：送 = 全量替换；唔送 = 保持現行） */
  clinicIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  active: z.boolean().optional(),
  newPassword: z.string().min(8).max(128).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export const PUT = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin(req);
  const { id } = await ctx.params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const { newPassword, ...fields } = parsed.data;

  const target = await prisma.staffUser.findUnique({ where: { id } });
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  const self = admin.staff.id === id;
  const effectiveRole = fields.role ?? target.role;
  const effectiveActive = fields.active ?? target.active;
  // ★ cwi-hub-a-20260914：effective scope — SUPERVISOR 恆 ALL（現行無 scope 概念）；
  //   冇送 scope 欄：role 改動 → 重置返該角色 default（STAFF→CLINICS、ADMIN→ALL）；否則保持現行。
  const effectiveScopeType: "ALL" | "COMPANY" | "CLINICS" =
    effectiveRole === "SUPERVISOR"
      ? "ALL"
      : fields.scopeType ?? (fields.role !== undefined ? (effectiveRole === "STAFF" ? "CLINICS" : "ALL") : (target.scopeType as "ALL" | "COMPANY" | "CLINICS"));
  const effectiveScopeCompanyId =
    effectiveScopeType === "COMPANY" ? (fields.scopeCompanyId ?? target.scopeCompanyId) : null;
  const scopeChanged =
    fields.role !== undefined ||
    fields.scopeType !== undefined ||
    fields.scopeCompanyId !== undefined ||
    fields.clinicIds !== undefined ||
    (fields.clinicId !== undefined && effectiveScopeType === "CLINICS");

  // CLINICS 模式 → 有效診所集合（送 clinicIds/clinicId = 全量 replace；唔送 = 保持現行 StaffClinic）
  let clinicList: string[] = [];
  if (effectiveScopeType === "CLINICS") {
    if (fields.clinicIds !== undefined || fields.clinicId !== undefined) {
      const legacy = fields.clinicId ?? null;
      clinicList = [...new Set([...(fields.clinicIds ?? []), ...(legacy ? [legacy] : [])])];
    } else {
      const rows = await prisma.staffClinic.findMany({ where: { staffId: id }, select: { clinicId: true } });
      clinicList = rows.map((r) => r.clinicId);
    }
    // ★ cwi-hub-a：任何角色 CLINICS 模式都要 ≥1 間診所（防止「無範圍 = 跨店」隱藏 ADMIN）
    if (clinicList.length === 0) {
      return NextResponse.json({ error: "CLINICS 範圍必須揀最少一間診所" }, { status: 400 });
    }
  }

  // scope 驗證（任何最終狀態都要合法 — fail-closed）
  if (effectiveScopeType === "COMPANY" && !effectiveScopeCompanyId) {
    return NextResponse.json({ error: "COMPANY 範圍必須揀公司" }, { status: 400 });
  }
  if (effectiveScopeCompanyId) {
    const company = await prisma.company.findUnique({ where: { id: effectiveScopeCompanyId } });
    if (!company) return NextResponse.json({ error: "company not found" }, { status: 400 });
  }
  if (clinicList.length > 0) {
    const found = await prisma.clinic.findMany({ where: { id: { in: clinicList } }, select: { id: true } });
    if (found.length !== clinicList.length) return NextResponse.json({ error: "clinic not found" }, { status: 400 });
  }
  const effectiveClinic = fields.clinicId === undefined ? target.clinicId : fields.clinicId;
  if (effectiveRole === "ADMIN" && effectiveScopeType === "ALL" && effectiveClinic) {
    return NextResponse.json({ error: "ADMIN clinicId 必須為 null（跨店）" }, { status: 400 });
  }
  // ★ cwi-statusrole2-20260910（MD §5.2）：SUPERVISOR = 全店（clinicId 必 null）
  if (effectiveRole === "SUPERVISOR" && effectiveClinic) {
    return NextResponse.json({ error: "SUPERVISOR clinicId 必須為 null（全店）" }, { status: 400 });
  }

  // 鎖死保護：最後一個 active ADMIN 唔可以被降權/停用（自己或他人）
  if (target.role === "ADMIN" && target.active) {
    const activeAdmins = await prisma.staffUser.count({ where: { role: "ADMIN", active: true } });
    const losesAdmin = effectiveRole !== "ADMIN" || effectiveActive === false;
    if (activeAdmins <= 1 && losesAdmin) {
      return NextResponse.json(
        { error: "最後一個 active ADMIN 唔可以降權/停用 — 先開多一個 ADMIN" },
        { status: 409 }
      );
    }
  }
  // 自鎖死保護：ADMIN 唔可以停用/降權自己（會即刻出唔到管理頁，又要人改 DB）
  if (self && (fields.active === false || fields.role === "STAFF")) {
    return NextResponse.json(
      { error: "唔可以停用/降權自己 — 先開多一個 ADMIN 先" },
      { status: 409 }
    );
  }

  const user = await prisma.staffUser.update({
    where: { id },
    data: {
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.role !== undefined ? { role: fields.role } : {}),
      // ★ cwi-hub-a-20260914：scope 欄 + clinicId 派生（CLINICS = 頭間店 = 主店；其餘 = null）
      ...(scopeChanged
        ? {
            scopeType: effectiveScopeType,
            scopeCompanyId: effectiveScopeCompanyId,
            clinicId: effectiveScopeType === "CLINICS" ? clinicList[0] : null,
          }
        : {}),
      ...(fields.active !== undefined ? { active: fields.active } : {}),
      ...(newPassword ? { passwordHash: await argon2.hash(newPassword) } : {}),
    },
  });

  // ★ cwi-hub-a-20260914：StaffClinic 同步（replace 語義；非 CLINICS scope 清走舊行防髒狀態）。
  //   scope 改動下次 login 生效（session snapshot 語義 — 同現行 clinicId 改動一致）。
  if (scopeChanged) {
    await prisma.staffClinic.deleteMany({ where: { staffId: id } });
    if (effectiveScopeType === "CLINICS") {
      await prisma.staffClinic.createMany({
        data: clinicList.map((cid, i) => ({ staffId: id, clinicId: cid, isPrimary: i === 0 })),
      });
    }
  }

  // ★ P0-3：active 任何改動都即時生效（60s cache 唔准令停用/重啟遲到）：
  //   1) 本 instance（API route 世界）嘅 requireAuth cache 即時失效 → 下一個 API request 即刻 401
  //   2) 經 Redis control channel 通知「持 io 嗰份 hub instance」→ 強制斷已連 socket
  //      （而唔係直接調 disconnectStaff() — 兩邊係唔同 module instance，直接調會落到
  //        state.io === null 嗰份 → 靜默 no-op，見 hub.ts initControlBridge 註釋）
  if (fields.active !== undefined && fields.active !== target.active) {
    invalidateActiveCache(id);
    publishControl({ cmd: "staff:changed", staffId: id, active: fields.active });
    if (fields.active === false) {
      // ★ cwi-inboxfix-20260905（§7 跌公海表）：負責人帳號停用 → 佢負責嘅對話即時跌返公海。
      //   現行 P0-3 只切存取（cache + socket），唔郁 conversations（MD：agent 檢查，冇就補）。
      //   鏡像 [id] route 放手不變式：assignVersion+1（R5）、slaNotifiedAt 保留（唔重新洗版）、
      //   逐對話 conv:updated（clinicId-scoped socket — 店內列表即時見到跌公海）。
      const held = await prisma.conversation.findMany({ where: { assigneeId: id } });
      for (const h of held) {
        await prisma.conversation.update({
          where: { id: h.id },
          data: {
            assigneeId: null,
            assignVersion: { increment: 1 },
            assignedAt: null,
            assigneeLastActionAt: null,
          },
        });
        publishNotify(h.clinicId, "conv:updated", {
          conversationId: h.id,
          clinicId: h.clinicId,
          status: h.status,
          assigneeId: null,
          assignVersion: h.assignVersion + 1,
          unreadCount: h.unreadCount,
        });
      }
      log.info({ staffId: id, released: held.length }, "staff: account disabled — active cache invalidated + control broadcast + assigned conversations released to public pool");
    } else {
      log.info({ staffId: id }, "staff: account re-enabled — active cache invalidated + control broadcast");
    }
  }

  // ★ C-3 尾批：password reset → 舊 session 全部失效（同停用同水位）：
  //   1) 本 instance（API route 世界）cutoff → 舊 cookie 下一 request 即刻 401
  //   2) control broadcast → 持 io 嗰份 instance 設自己 cutoff + 斷已連 socket
  if (newPassword) {
    await invalidateStaffSessions(id);
    publishControl({ cmd: "staff:sessions-invalidated", staffId: id });
    log.info({ staffId: id }, "staff: password reset — all sessions invalidated (cutoff + control broadcast)");
  }

  const { passwordHash: _ph, ...safe } = user;
  return NextResponse.json({ ...safe, passwordReset: Boolean(newPassword) });
});

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin(req);
  const { id } = await ctx.params;

  if (admin.staff.id === id) {
    return NextResponse.json({ error: "唔可以刪除自己 — 用停用（active=false）" }, { status: 400 });
  }
  const [messages, assigned] = await Promise.all([
    prisma.message.count({ where: { sentByStaffId: id } }),
    prisma.conversation.count({ where: { assigneeId: id } }),
  ]);
  if (messages > 0 || assigned > 0) {
    return NextResponse.json(
      {
        error: "staff has dependent data — 用 active=false 停用，唔好硬刪",
        detail: { sentMessages: messages, assignedConversations: assigned },
      },
      { status: 409 }
    );
  }
  await prisma.staffUser.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
