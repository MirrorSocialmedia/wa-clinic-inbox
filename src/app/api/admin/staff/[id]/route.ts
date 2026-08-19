import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import { requireAdmin, invalidateActiveCache } from "@/lib/rbac";
import { publishControl } from "@/lib/notify";
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
 * DELETE: 硬刪 — 有 Message.sentByStaffId / Conversation.assigneeId 引用 → 409
 *         （改用 active=false 停用）
 */
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(["ADMIN", "STAFF"]).optional(),
  clinicId: z.string().min(1).max(64).nullable().optional(),
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
  const effectiveClinic = fields.clinicId === undefined ? target.clinicId : fields.clinicId;
  const effectiveActive = fields.active ?? target.active;

  // STAFF 必須綁店（任何最終狀態都唔可以係「STAFF + 冇店」）
  if (effectiveRole === "STAFF" && !effectiveClinic) {
    return NextResponse.json({ error: "STAFF 必須綁定 clinicId" }, { status: 400 });
  }
  if (effectiveRole === "ADMIN" && effectiveClinic) {
    return NextResponse.json({ error: "ADMIN clinicId 必須為 null" }, { status: 400 });
  }
  if (effectiveClinic) {
    const clinic = await prisma.clinic.findUnique({ where: { id: effectiveClinic } });
    if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 400 });
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
      ...(fields.clinicId !== undefined ? { clinicId: fields.clinicId } : {}),
      ...(fields.active !== undefined ? { active: fields.active } : {}),
      ...(newPassword ? { passwordHash: await argon2.hash(newPassword) } : {}),
    },
  });

  // ★ P0-3：active 任何改動都即時生效（60s cache 唔准令停用/重啟遲到）：
  //   1) 本 instance（API route 世界）嘅 requireAuth cache 即時失效 → 下一個 API request 即刻 401
  //   2) 經 Redis control channel 通知「持 io 嗰份 hub instance」→ 強制斷已連 socket
  //      （而唔係直接調 disconnectStaff() — 兩邊係唔同 module instance，直接調會落到
  //        state.io === null 嗰份 → 靜默 no-op，見 hub.ts initControlBridge 註釋）
  if (fields.active !== undefined && fields.active !== target.active) {
    invalidateActiveCache(id);
    publishControl({ cmd: "staff:changed", staffId: id, active: fields.active });
    if (fields.active === false) {
      log.info({ staffId: id }, "staff: account disabled — active cache invalidated + control broadcast");
    } else {
      log.info({ staffId: id }, "staff: account re-enabled — active cache invalidated + control broadcast");
    }
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
