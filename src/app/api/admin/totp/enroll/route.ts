import { type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { generateTotpSecret, otpauthUri } from "@/lib/totp";
import { encryptTotpSecret } from "@/lib/totp-enc";

/**
 * POST /api/admin/totp/enroll — ADMIN 啟用 TOTP 兩步驟（安全審計 H-2）。
 *
 * 生成 20-byte random secret → AES-256-GCM 加密落 DB（totpSecretEnc）→
 * 回傳 otpauth:// URI + secret（**只此一次顯示** — authenticator app 掃 QR 或
 * 手輸入後就冇機會再見到；重啟 = 再 POST 一次 = rotation，舊 secret 作廢）。
 *
 * ★ secret / TOTP code 永唔入 log（PII/secret 鐵律）— log 只記 staffId。
 *
 * 生效時機：下一次 ADMIN 登入起（本次 session 唔會突然要第二步 — 已登入
 * 用戶唔會喺用緊嘅 session 中途被鎖）。STAFF 永遠唔涉及（totpSecretEnc 恆 NULL）。
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);

  const secret = generateTotpSecret();
  // TOTP_ENC_KEY 冇 / 格式壞 → throw → 500（server 配置錯 — 醒目，唔靜默）
  const enc = encryptTotpSecret(secret);

  await prisma.staffUser.update({
    where: { id: ctx.staff.id },
    data: { totpSecretEnc: enc },
  });

  const uri = otpauthUri(ctx.staff.email, secret);
  log.info({ staffId: ctx.staff.id }, "totp: enrolled（secret 唔入 log）");

  return new Response(JSON.stringify({ ok: true, secret, uri }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
