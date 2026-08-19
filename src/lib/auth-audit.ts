/**
 * 登入審計 + ADMIN 新 IP alert（安全審計 H-2 配套）。
 *
 * - 所有成功登入寫 AuditLog LOGIN（meta.ip — metadata only，C-level；
 *   唔存 password / token / 任何 PII）
 * - ADMIN only：同該帳號**最近 7 日** LOGIN IP 比較 → 新 IP → notifyAlert
 *   （行 M-2 hard-gate — detail 只准白名單欄位；fail-soft，絕唔阻擋登入）
 *
 * 注意：比較 query 必須喺寫入本次 LOGIN row **之前**執行 —
 * 否則剛寫入嘅 row 一定 match 到自己，alert 永遠唔會響。
 */
import prisma from "./prisma";
import log from "./log";
import { notifyAlert } from "./health/notify";

const RECENT_LOGIN_WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 日

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function recordLoginAudit(
  staffId: string,
  role: "ADMIN" | "STAFF",
  ip: string
): Promise<void> {
  // 1) ADMIN：先查近期 IP（寫入前 — 見上方註釋）
  let newIp = false;
  if (role === "ADMIN") {
    try {
      const seen = await prisma.auditLog.findFirst({
        where: {
          staffId,
          action: "LOGIN",
          createdAt: { gt: new Date(Date.now() - RECENT_LOGIN_WINDOW_MS) },
          meta: { path: ["ip"], equals: ip },
        },
        select: { id: true },
      });
      newIp = !seen;
    } catch (err) {
      // fail-soft：查唔到就唔 alert（唔誤報）
      log.warn({ staffId, err: msg(err) }, "auth-audit: new-IP check failed（fail-soft，唔誤報）");
    }
  }

  // 2) 寫 AuditLog LOGIN（metadata only）
  try {
    await prisma.auditLog.create({
      data: {
        staffId,
        action: "LOGIN",
        entity: "StaffUser",
        entityId: staffId,
        meta: { ip },
      },
    });
  } catch (err) {
    log.warn({ staffId, err: msg(err) }, "auth-audit: LOGIN audit 寫入失敗");
  }

  // 3) ADMIN 新 IP → Alert row（冪等：同 type 已有未解決 alert 就唔重開 — 對齊
  //    health/quality check 模式）+ notifyAlert（detail 只白名單欄位：ip / staffId — 皆短字串）
  if (role === "ADMIN" && newIp) {
    try {
      const existing = await prisma.alert.findFirst({
        where: { type: "admin_new_ip_login", clinicId: null, resolvedAt: null },
        select: { id: true },
      });
      if (!existing) {
        await prisma.alert.create({
          data: {
            type: "admin_new_ip_login",
            severity: "MEDIUM",
            clinicId: null,
            clinicCode: null,
            detail: { ip, staffId },
          },
        });
      }
      await notifyAlert({
        type: "admin_new_ip_login",
        severity: "MEDIUM",
        clinicCode: null,
        detail: { ip, staffId },
      });
      log.warn({ staffId }, "auth-audit: ADMIN login from new IP — alert sent");
    } catch (err) {
      log.warn({ staffId, err: msg(err) }, "auth-audit: new-IP alert failed（fail-soft）");
    }
  }
}
