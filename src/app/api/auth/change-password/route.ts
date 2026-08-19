import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, invalidateStaffSessions } from "@/lib/rbac";
import { publishControl } from "@/lib/notify";
import { handle, toResponse } from "@/lib/api-error";

/**
 * POST /api/auth/change-password — 任何登入用戶改自己密碼（安全審計 M-4）。
 *
 * - 驗舊密碼（argon2.verify）→ 錯 → 401（統一，唔洩露邊個欄位錯）
 * - 新密碼政策同 admin reset 一致（8-128）；唔可以同舊密碼一樣
 * - 成功：argon2 寫新 → ★ 重用 C-3 嘅 loginAt cutoff 踢晒該帳號所有 session
 *   （本地 cutoff + control broadcast 斷已連 socket）— 包括當前 session：
 *   改完 = 用新密碼重登（回應 { relogin: true } 提示前端）
 * - AuditLog PASSWORD_CHANGE（metadata only）
 *
 * 跟 admin 代改嘅分別：呢度係用戶自己改自己（requireAuth，唔使 ADMIN），
 * 所以冇「最後一個 ADMIN」鎖死問題（改自己密碼唔改 role/active）。
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  oldPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(128),
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const { oldPassword, newPassword } = parsed.data;

  const user = await prisma.staffUser.findUnique({ where: { id: ctx.staff.id } });
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ok = await argon2.verify(user.passwordHash, oldPassword).catch(() => false);
  if (!ok) {
    return NextResponse.json({ error: "incorrect old password" }, { status: 401 });
  }
  if (newPassword === oldPassword) {
    return NextResponse.json({ error: "new password must differ from old" }, { status: 400 });
  }

  await prisma.staffUser.update({
    where: { id: user.id },
    data: { passwordHash: await argon2.hash(newPassword) },
  });

  // ★ C-3 重用：踢晒該帳號所有舊 session（含當前 — 改完用新密碼重登）
  await invalidateStaffSessions(user.id);
  publishControl({ cmd: "staff:sessions-invalidated", staffId: user.id });

  await prisma.auditLog.create({
    data: {
      staffId: user.id,
      action: "PASSWORD_CHANGE",
      entity: "StaffUser",
      entityId: user.id,
    },
  }).catch(() => undefined);

  log.info({ staffId: user.id }, "change-password: done — all sessions invalidated");
  return NextResponse.json({ ok: true, relogin: true });
});
