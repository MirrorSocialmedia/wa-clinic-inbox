import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAdmin, RbacError, isStaffActive } from "@/lib/rbac";
import { getSession } from "@/lib/session";
import { handle, toResponse } from "@/lib/api-error";
import { generateTotpSecret, otpauthUri, matchedTotpStep } from "@/lib/totp";
import { encryptTotpSecret, decryptTotpSecret } from "@/lib/totp-enc";

/**
 * POST /api/admin/totp/enroll — TOTP enroll 第一段（cwi-final S3-5 兩段式；取代 H-2 舊直接寫 totpSecretEnc）。
 *
 * 生成 20-byte random secret → AES-256-GCM 加密落 **totpPendingEnc**（待確認）→
 * 回傳 otpauth:// URI + secret（**只此一次顯示**）。confirm（/api/admin/totp/confirm）
 * 驗過 code 先搬去 totpSecretEnc 生效（AuditLog TOTP_ENROLLED + Alert MEDIUM）。
 *
 * body：
 * - `password`（必）— argon2 再認證（防 session 被劫後靜默加 MFA）
 * - `currentCode`（已有 TOTP 時必）— rotation 先過現行 code
 *
 * 授權兩軌：
 * - 正常軌：requireAdmin（ADMIN 自願 enroll / rotation）
 * - 強制軌：enrollOnly session（S3-5 強制 enroll 段 — rbac gate 已只放行 /api/admin/totp/*）；
 *   SUPERVISOR 強制 enroll 只行到呢條軌（requireAdmin 會 403）
 *
 * ★ secret / TOTP code 永唔入 log（PII/secret 鐵律）— log 只記 staffId。
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  password: z.string().min(1).max(200),
  currentCode: z.string().trim().regex(/^\d{6}$/, "currentCode must be 6 digits").optional(),
});

export const POST = handle(async (req: NextRequest) => {
  const { data } = await getSession(req);
  if (!data) throw new RbacError(401, "unauthorized");

  // 授權兩軌（見檔頭註釋）：requireAdmin 已驗 active（P0-3 fail-closed）；
  // enrollOnly 軌只經 getSession（唔驗 active）→ 明驗一次（停用帳戶 15 分鐘窗口內唔准 enroll）
  let staffId: string;
  if (data.enrollOnly) {
    staffId = data.staffId;
    if (!(await isStaffActive(staffId))) throw new RbacError(401, "account disabled");
  } else {
    staffId = (await requireAdmin(req)).staff.id;
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const { password, currentCode } = parsed.data;

  const user = await prisma.staffUser.findUnique({ where: { id: staffId } });
  if (!user) throw new RbacError(401, "unauthorized");

  // 再認證：password argon2 verify
  const pwOk = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!pwOk) {
    log.warn({ staffId }, "totp enroll: password 再認證失敗");
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  // rotation：已有 TOTP → 現行 code 必過（防 session 劫持後換走 MFA）
  if (user.totpSecretEnc) {
    if (!currentCode) {
      return NextResponse.json({ error: "currentCode required" }, { status: 400 });
    }
    let ok = false;
    try {
      ok = matchedTotpStep(decryptTotpSecret(user.totpSecretEnc), currentCode) !== null;
    } catch (err) {
      log.error({ staffId, err: err instanceof Error ? err.message : String(err) }, "totp enroll: current secret decrypt failed — TOTP_ENC_KEY 丟/錯？");
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }
    if (!ok) {
      return NextResponse.json({ error: "invalid currentCode" }, { status: 401 });
    }
  }

  const secret = generateTotpSecret();
  // TOTP_ENC_KEY 冇 / 格式壞 → throw → 500（server 配置錯 — 醒目，唔靜默）
  const enc = encryptTotpSecret(secret);

  await prisma.staffUser.update({
    where: { id: staffId },
    data: { totpPendingEnc: enc },
  });

  const uri = otpauthUri(user.email, secret);
  log.info({ staffId }, "totp: enroll pending（secret 唔入 log）");

  return new Response(
    JSON.stringify({ ok: true, secret, uri, pending: true }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
