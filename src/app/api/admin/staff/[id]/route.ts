import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import { requireAdmin, invalidateActiveCache, invalidateStaffSessions, resolveClinicIds, isGlobalAdmin, type ScopeType } from "@/lib/rbac";
import { publishControl, publishConvEvent } from "@/lib/notify";
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

  // ★ cwi-final S3-1 步驟 0（臨時守衛 — spec 碼逐字）：ALLOW_SCOPED_ADMIN 未開 → scoped ADMIN 一律 400
  if (effectiveRole === "ADMIN" && effectiveScopeType !== "ALL" && process.env.ALLOW_SCOPED_ADMIN !== "1") {
    return NextResponse.json({ error: "SCOPED_ADMIN_DISABLED", message: "公司／指定診所範圍 ADMIN 要等權限修復（cwi-final S3-1）上線先開" }, { status: 400 });
  }
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

  // ★ cwi-final S3-1（spec 碼逐字 — effective* 計完之後）：非 global 嘅 staff 管理限制
  const callerGlobal = isGlobalAdmin(admin);
  if (!callerGlobal) {
    if (self && (fields.role !== undefined || fields.scopeType !== undefined || fields.scopeCompanyId !== undefined || fields.clinicIds !== undefined || fields.clinicId !== undefined)) {
      return NextResponse.json({ error: "FORBIDDEN", message: "唔可以改自己嘅角色或範圍" }, { status: 403 });
    }
    if (!self && target.role !== "STAFF") {
      return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以管理 ADMIN／SUPERVISOR" }, { status: 403 });
    }
    if (effectiveRole !== "STAFF" && !self) {
      return NextResponse.json({ error: "FORBIDDEN", message: "唔可以將員工升做 ADMIN／SUPERVISOR" }, { status: 403 });
    }
    if (effectiveScopeType === "ALL") {
      return NextResponse.json({ error: "FORBIDDEN", message: "唔可以設全集團範圍" }, { status: 403 });
    }
    const callerSet = new Set(admin.scopedClinicIds);
    const [targetOld, targetNew] = await Promise.all([
      resolveClinicIds({ scopeType: target.scopeType as ScopeType, scopeCompanyId: target.scopeCompanyId, staffClinicIds: (await prisma.staffClinic.findMany({ where: { staffId: id }, select: { clinicId: true } })).map((r) => r.clinicId) }),
      resolveClinicIds({ scopeType: effectiveScopeType, scopeCompanyId: effectiveScopeCompanyId, staffClinicIds: clinicList }),
    ]);
    if (!self && [...targetOld, ...targetNew].some((c) => !callerSet.has(c))) {
      return NextResponse.json({ error: "FORBIDDEN", message: "目標員工範圍超出你嘅範圍" }, { status: 403 });
    }
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

  // ★ cwi-final S1-4：staff 範圍/帳號改動 → 清各 process 嘅 publishConvEvent scope cache（60s → 即刻）。
  //   PUT 成功（update + StaffClinic sync 已 commit）即發；名改動都發 = 無害（cache 清 = 下次重查）。
  publishControl({ cmd: "scope:changed" });

  // ★ P0-3：active 任何改動都即時生效（60s cache 唔准令停用/重啟遲到）：
  //   1) 本 instance（API route 世界）嘅 requireAuth cache 即時失效 → 下一個 API request 即刻 401
  //   2) 經 Redis control channel 通知「持 io 嗰份 hub instance」→ 強制斷已連 socket
  //      （而唔係直接調 disconnectStaff() — 兩邊係唔同 module instance，直接調會落到
  //        state.io === null 嗰份 → 靜默 no-op，見 hub.ts initControlBridge 註釋）
  if (fields.active !== undefined && fields.active !== target.active) {
    invalidateActiveCache(id);
    publishControl({ cmd: "staff:changed", staffId: id, active: fields.active });
    if (fields.active === false) {
      // ★ cwi-final S1-9（L-4 真問題）：負責人帳號停用 → 原子釋放（$transaction 逐對話 updateMany）。
      //   自指條件 { id, OR:[assigneeId=id / routedStaffId=id] } = 並發核心：
      //   期間被接手嘅對話（assigneeId 已變）→ updateMany 命中 0 行 → 唔郁（T709 並發斷言）。
      //   INTERNAL 備註留痕（非 RESOLVED 行）；audit STAFF_DISABLED_RELEASE；
      //   conv room 事件 = publishConvEvent（clinicId-scoped socket — 店內列表即刻見到跌公海）。
      const released = await prisma.$transaction(async (tx) => {
        const held = await tx.conversation.findMany({
          where: { OR: [{ assigneeId: id }, { routedStaffId: id }] },
          select: { id: true, clinicId: true, status: true, assigneeId: true, assignVersion: true, unreadCount: true, routedGroupId: true, routedStaffId: true },
        });
        const out: typeof held = [];
        for (const h of held) {
          const r = await tx.conversation.updateMany({
            where: { id: h.id, OR: [{ assigneeId: id }, { routedStaffId: id }] }, // ★ 條件：期間被接手嘅唔郁
            data: {
              ...(h.assigneeId === id ? { assigneeId: null, assignVersion: { increment: 1 }, assignedAt: null, assigneeLastActionAt: null } : {}),
              ...(h.routedStaffId === id ? { routedStaffId: null } : {}),
            },
          });
          if (r.count === 1) {
            out.push(h);
            if (h.assigneeId === id && h.status !== "RESOLVED") {
              await tx.message.create({
                data: {
                  conversationId: h.id, direction: "OUT", channel: "INTERNAL", type: "note",
                  body: "原負責人帳號已停用，對話已放返公海。", status: "SENT",
                  sentByStaffId: admin.staff.id, waTimestamp: new Date(),
                },
              });
            }
          }
        }
        await tx.auditLog.create({ data: { staffId: admin.staff.id, action: "STAFF_DISABLED_RELEASE", entity: "StaffUser", entityId: id, meta: { released: out.length } as object } });
        return out;
      });
      for (const h of released) {
        if (h.assigneeId === id) {
          await publishConvEvent({ ...h, assigneeId: null, routedStaffId: h.routedStaffId === id ? null : h.routedStaffId }, "conv:updated", {
            conversationId: h.id, clinicId: h.clinicId, status: h.status, assigneeId: null, assignVersion: h.assignVersion + 1, unreadCount: h.unreadCount,
          });
        }
      }
      log.info({ staffId: id, released: released.length }, "staff: account disabled — active cache invalidated + control broadcast + held conversations atomically released to public pool (S1-9)");
    } else {
      log.info({ staffId: id }, "staff: account re-enabled — active cache invalidated + control broadcast");
    }
  }

  // ★ cwi-final S1-9：scope 改動 → 佢係 assignee 但跌出新範圍嘅 OPEN 對話 → 同樣原子釋放（自指條件）
  //   + INTERNAL 備註「原負責人已唔再負責 {店}」（新範圍用 resolveClinicIds 計；ALL scope = 全部店 → 唔郁）。
  if (scopeChanged && fields.active !== false) {
    const scopedIds = await resolveClinicIds({
      scopeType: effectiveScopeType,
      scopeCompanyId: effectiveScopeCompanyId,
      staffClinicIds: effectiveScopeType === "CLINICS" ? clinicList : [],
    });
    const releasedScope = await prisma.$transaction(async (tx) => {
      const rows = await tx.conversation.findMany({
        where: { assigneeId: id, status: "OPEN", clinicId: { notIn: scopedIds } },
        select: { id: true, clinicId: true, status: true, assigneeId: true, assignVersion: true, unreadCount: true, routedGroupId: true, routedStaffId: true },
      });
      const clinicCode = new Map(
        (await tx.clinic.findMany({ where: { id: { in: rows.map((r) => r.clinicId) } }, select: { id: true, code: true } })).map((c) => [c.id, c.code] as const)
      );
      const out: typeof rows = [];
      for (const h of rows) {
        const r = await tx.conversation.updateMany({
          where: { id: h.id, assigneeId: id }, // ★ 自指條件：期間被接手嘅唔郁
          data: {
            assigneeId: null, assignVersion: { increment: 1 }, assignedAt: null, assigneeLastActionAt: null,
            ...(h.routedStaffId === id ? { routedStaffId: null } : {}),
          },
        });
        if (r.count === 1) {
          out.push(h);
          await tx.message.create({
            data: {
              conversationId: h.id, direction: "OUT", channel: "INTERNAL", type: "note",
              body: `原負責人已唔再負責 ${clinicCode.get(h.clinicId) ?? h.clinicId}。`, status: "SENT",
              sentByStaffId: admin.staff.id, waTimestamp: new Date(),
            },
          });
        }
      }
      if (out.length > 0) {
        await tx.auditLog.create({ data: { staffId: admin.staff.id, action: "STAFF_SCOPE_CHANGED_RELEASE", entity: "StaffUser", entityId: id, meta: { released: out.length, scopedClinics: scopedIds } as object } });
      }
      return out;
    });
    for (const h of releasedScope) {
      await publishConvEvent({ ...h, assigneeId: null, routedStaffId: h.routedStaffId === id ? null : h.routedStaffId }, "conv:updated", {
        conversationId: h.id, clinicId: h.clinicId, status: h.status, assigneeId: null, assignVersion: h.assignVersion + 1, unreadCount: h.unreadCount,
      });
    }
    if (releasedScope.length > 0) {
      log.info({ staffId: id, released: releasedScope.length }, "staff: scope changed — out-of-scope OPEN conversations atomically released (S1-9)");
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

  // ★ cwi-final S3-1：非 global 同樣要「目標係 STAFF 且範圍 ⊆ 我範圍」（同 PUT 守門一致）
  if (!isGlobalAdmin(admin)) {
    const target = await prisma.staffUser.findUnique({ where: { id }, select: { role: true, scopeType: true, scopeCompanyId: true } });
    if (target && target.role !== "STAFF") {
      return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以管理 ADMIN／SUPERVISOR" }, { status: 403 });
    }
    if (target) {
      const callerSet = new Set(admin.scopedClinicIds);
      const targetIds = await resolveClinicIds({ scopeType: target.scopeType as ScopeType, scopeCompanyId: target.scopeCompanyId, staffClinicIds: (await prisma.staffClinic.findMany({ where: { staffId: id }, select: { clinicId: true } })).map((r) => r.clinicId) });
      if (targetIds.some((c) => !callerSet.has(c))) {
        return NextResponse.json({ error: "FORBIDDEN", message: "目標員工範圍超出你嘅範圍" }, { status: 403 });
      }
    }
  }

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
