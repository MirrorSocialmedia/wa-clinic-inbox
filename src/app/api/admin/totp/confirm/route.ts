import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAdmin, RbacError, isStaffActive } from "@/lib/rbac";
import { getSession } from "@/lib/session";
import { handle, toResponse } from "@/lib/api-error";
import { matchedTotpStep } from "@/lib/totp";
import { decryptTotpSecret } from "@/lib/totp-enc";
import { getRedis } from "@/lib/queue";

/**
 * POST /api/admin/totp/confirm — TOTP enroll 第二段（cwi-final S3-5 兩段式）。
 *
 * body { code }：驗過 pending secret（30s ±1 window）先將 totpPendingEnc 搬去 totpSecretEnc
 * （一次 update — 原子生效）+ 清 totpPendingEnc + AuditLog TOTP_ENROLLED + Alert(MEDIUM)。
 *
 * 授權兩軌（同 enroll）：
 * - 正常軌：requireAdmin（ADMIN rotation confirm）
 * - 強制軌：enrollOnly session（SUPERVISOR 強制 enroll 收口）
 *
 * ★ code 永唔入 log（PII/secret 鐵律）— log 只記 staffId。
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "code must be 6 digits"),
});

export const POST = handle(async (req: NextRequest) => {
  const { data } = await getSession(req);
  if (!data) throw new RbacError(401, "unauthorized");
  let staffId: string;
  if (data.enrollOnly) {
    staffId = data.staffId;
    if (!(await isStaffActive(staffId))) throw new RbacError(401, "account disabled");
  } else {
    staffId = (await requireAdmin(req)).staff.id; // requireAdmin 已驗 active
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const { code } = parsed.data;

  const user = await prisma.staffUser.findUnique({ where: { id: staffId } });
  if (!user || !user.totpPendingEnc) {
    return NextResponse.json({ error: "no pending enrollment" }, { status: 400 });
  }

  let ok = false;
  let pendingEnc: string;
  try {
    pendingEnc = user.totpPendingEnc;
    ok = matchedTotpStep(decryptTotpSecret(pendingEnc), code) !== null;
  } catch (err) {
    log.error({ staffId, err: err instanceof Error ? err.message : String(err) }, "totp confirm: pending secret decrypt failed — TOTP_ENC_KEY 丟/錯？");
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
  if (!ok) {
    log.warn({ staffId }, "totp confirm: code 唔匹配 pending secret");
    return NextResponse.json({ error: "invalid code" }, { status: 401 });
  }

  // 搬 pending → active（原子一次寫）
  await prisma.staffUser.update({
    where: { id: staffId },
    data: { totpSecretEnc: pendingEnc, totpPendingEnc: null },
  });
  // 乾淨起步：清 TOTP 失敗計數 + 重放標記（enroll 流程期間嘅錯 code 唔該影響生效後第一次登入）
  await getRedis()
    .del(`totpfail:${staffId}`, `totp:last:${staffId}`)
    .catch(() => undefined);

  await prisma.auditLog
    .create({
      data: {
        staffId,
        action: "TOTP_ENROLLED",
        entity: "StaffUser",
        entityId: staffId,
      },
    })
    .catch((err) => log.warn({ staffId, err: err instanceof Error ? err.message : String(err) }, "totp confirm: AuditLog 寫失敗（fail-soft）"));

  // Alert MEDIUM（事件型 — detail 只白名單欄位：staffId）
  try {
    const existing = await prisma.alert.findFirst({
      where: { type: "totp_enrolled", resolvedAt: null },
    });
    if (!existing) {
      await prisma.alert.create({
        data: { type: "totp_enrolled", severity: "MEDIUM", detail: { staffId } },
      });
    }
  } catch (err) {
    log.warn({ staffId, err: err instanceof Error ? err.message : String(err) }, "totp confirm: Alert 寫失敗（fail-soft）");
  }

  log.info({ staffId }, "totp: confirmed → totpSecretEnc 生效（code 唔入 log）");
  return NextResponse.json({ ok: true });
});
