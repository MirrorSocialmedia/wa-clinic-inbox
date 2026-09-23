import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { setSession } from "@/lib/session";
import { resolveClinicIds } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { recordLoginAudit } from "@/lib/auth-audit";
import { clearLoginFailures } from "@/lib/auth-lockout";
import { getRedis } from "@/lib/queue";
import { matchedTotpStep } from "@/lib/totp";
import { decryptTotpSecret } from "@/lib/totp-enc";
import { clientIpFromHeaders, hit, loginSoftDelayMs } from "@/lib/rate-limit";
import { waMock } from "@/lib/wa/graph";

/**
 * POST /api/auth/login — email + argon2 verify（框架 MD §2：自建 auth）。
 *
 * - 帳號唔存在 / 密碼錯 / 停用 → 同一個 401（唔洩露邊個帳號存在）
 * - STAFF session 帶 clinicId（主店）+ clinicIds（綁定店集合 — cwi-h6-20260830 多店）；ADMIN 唔帶（null = 跨店）
 * - ★ S3-6 per-IP 限流（Redis sliding 10/分鐘 — clientIp = cf-connecting-ip / TRUST_PROXY 下 XFF 第一值）
 *   + per-account 軟延遲（20/15min 超過後 2^n 秒上限 30s — 取代舊 5 次硬鎖，防惡意鎖人）
 * - ★ H-2/S3-5 TOTP 兩步驟：`totpSecretEnc` 非 NULL（任何角色 — SUPERVISOR 強制 enroll 後都有）：
 *   password 過 → 要 6 位 code（30s ±1 window）；未帶 code → 401 { totpRequired: true }（UI 第二步）；
 *   錯/過期/重放 code → 統一 401（計入 totpfail；≥5 → 423「15 分鐘後再試」）。STAFF 流程完全唔變。
 * - ★ S3-5 強制 enroll：`TOTP_ENFORCE_FROM`（YYYY-MM-DD，今日 ≥ 該日生效）到期後
 *   ADMIN/SUPERVISOR 未 enroll → 發「enroll-only」session（15 分鐘窗口，除 /api/admin/totp/* 外 403），
 *   回 { needEnroll: true }。enroll（新 secret 落 totpPendingEnc）→ confirm（搬去 totpSecretEnc）→ 重登 2FA。
 * - ★ H-2 配套：成功登入寫 AuditLog LOGIN（meta.ip）+ ADMIN 新 IP（7 日窗口）
 *   → notifyAlert（recordLoginAudit — fail-soft）
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  // H-2/S3-5：TOTP 第二步（6 位數字）；未啟用帳號唔使送
  totp: z.string().trim().regex(/^\d{6}$/, "totp must be 6 digits").optional(),
});

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

// ── ★ S3-5 強制 enroll 日期（TOTP_ENFORCE_FROM=YYYY-MM-DD；dev .env.local 預設未到期 → OFF）──
function totpEnforceActive(): boolean {
  const from = (process.env.TOTP_ENFORCE_FROM ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return false;
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return today >= from;
}

/** ★ S3-5：TOTP 失敗計數（totpfail:<staffId> EX 900；≥5 → 423）。返新計數（Redis 故障 → 0，fail-open）。 */
async function totpFail(staffId: string): Promise<number> {
  const key = `totpfail:${staffId}`;
  try {
    const r = getRedis();
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, 900);
    return n;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "login: totpfail Redis 寫失敗（fail-open）");
    return 0;
  }
}

/** ★ S3-5：TOTP 已鎖（totpfail ≥ 5）？Redis 故障 → false（fail-open，同 totpFail 口徑）。 */
async function totpLocked(staffId: string): Promise<boolean> {
  try {
    const v = await getRedis().get(`totpfail:${staffId}`);
    return v !== null && parseInt(v, 10) >= 5;
  } catch {
    return false;
  }
}

export const POST = handle(async (req: NextRequest) => {
  const ip = clientIpFromHeaders(req.headers);

  // ★ S3-6：per-IP 限流 10/分鐘（Redis sliding window — mock-e2e 每 login 獨立 XFF bucket 避撞）
  if (!(await hit(`login:ip:${ip}`, 10, 60))) {
    log.warn({ ip }, "login: rate limited (IP)");
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const { email, password } = parsed.data;

  // ★ S3-6：per-account 軟延遲（20/15min 超過後 2^n 秒上限 30s — 防暴力 + 唔鎖人）
  const delayMs = waMock() ? 0 : await loginSoftDelayMs(email);
  if (delayMs > 0) {
    log.warn({ ip, delayMs }, "login: account soft delay（exceed 20/15min）");
    await new Promise((r) => setTimeout(r, delayMs));
  }

  const user = await prisma.staffUser.findUnique({ where: { email } });
  const pwOk = user
    ? await argon2.verify(user.passwordHash, password).catch(() => false)
    : false;
  if (!user || !pwOk) {
    return unauthorized();
  }
  if (!user.active) {
    log.warn({ staffId: user.id, ip }, "login: inactive account attempt");
    return unauthorized();
  }

  // ★ S3-5：clearLoginFailures 移到 TOTP 成功之後 — 冇 TOTP 帳號：密碼成功即清（現行行為保持）
  if (!user.totpSecretEnc) {
    await clearLoginFailures(email);
  }

  // ★ H-2/S3-5：TOTP 兩步驟 — totpSecretEnc 非 NULL 先有第二步（任何角色；STAFF 恆 NULL → 完全唔經過呢段）。
  //   SUPERVISOR 強制 enroll 完成後同 ADMIN 一樣 2FA。
  if (user.totpSecretEnc) {
    if (await totpLocked(user.id)) {
      // ★ S3-5：TOTP 錯 ≥5 次 → 423（15 分鐘冷卻 — totpfail EX 900 自然歸零）
      log.warn({ staffId: user.id, ip }, "login: totp locked (>=5 fails)");
      return NextResponse.json({ error: "totp locked — 15 分鐘後再試" }, { status: 423 });
    }
    if (!parsed.data.totp) {
      // 密碼過但未帶 code → 提示 UI 進第二步（唔係認證失敗 → 唔計 totpfail）
      return NextResponse.json({ error: "totp required", totpRequired: true }, { status: 401 });
    }
    let secret: string;
    try {
      secret = decryptTotpSecret(user.totpSecretEnc);
    } catch (err) {
      // 密文解唔到（TOTP_ENC_KEY 丟/錯）— 配置錯：fail-closed（唔靜默放行）+ ERROR log
      log.error({ staffId: user.id, err: err instanceof Error ? err.message : String(err) }, "login: totp secret decrypt failed — TOTP_ENC_KEY 丟/錯？");
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }
    const step = matchedTotpStep(secret, parsed.data.totp);
    // ★ S3-5 防重放：code 實際 step <= 上次已用 step（totp:last EX 120）→ 拒（同 code 唔可以用第二次）
    let replay = false;
    let last: string | null = null;
    if (step !== null) {
      try {
        last = await getRedis().get(`totp:last:${user.id}`);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "login: totp:last Redis 讀失敗（fail-open）");
      }
      if (last !== null && last !== "" && step <= parseInt(last, 10)) replay = true;
    }
    if (step === null || replay) {
      // 錯/過期/重放 code → 統一 401（唔洩露細節）+ totpfail 計數（≥5 → 423）
      const n = await totpFail(user.id);
      if (n >= 5) {
        log.warn({ staffId: user.id, ip }, "login: totp fail x5 → 423");
        return NextResponse.json({ error: "totp locked — 15 分鐘後再試" }, { status: 423 });
      }
      return unauthorized();
    }
    try {
      await getRedis().set(`totp:last:${user.id}`, String(step), "EX", 120);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "login: totp:last Redis 寫失敗（防重放降級 — 登入放行）");
    }
    // 成功 = 失敗「連續」斷裂：清 totpfail（防跨 run 累積 flake；EX 900 自然過期係主機制）
    await getRedis().del(`totpfail:${user.id}`).catch(() => undefined);
    await clearLoginFailures(email); // ★ S3-5：TOTP 成功 → 清失敗計數（「連續」語義）
  }

  // ★ S3-5 強制 enroll：ADMIN/SUPERVISOR 未 enroll + 強制日期已到期 → enroll-only session（15 分鐘）
  const needsEnroll =
    totpEnforceActive() &&
    (user.role === "ADMIN" || user.role === "SUPERVISOR") &&
    !user.totpSecretEnc;

  // ★ cwi-h6-20260830：多店員工 — 查 StaffClinic 一次過寫入 session（clinicIds）；
  //   clinicId = isPrimary 店（排序頭行）— UI default 店 / 通知分組用。
  //   舊資料（無 StaffClinic 行）fallback StaffUser.clinicId 單店。
  // ★ cwi-hub-a-20260914（Part A）：session clinic snapshot 跟 scope。
  // ★ cwi-hubaudit-20260915（H-4）：clinic 集合改由 **單一來源** `resolveClinicIds` 決定
  //   （舊 if/else 同 rbac.ts 重複邏輯 — ALL/COMPANY/CLINICS 語義一處定）；
  //   授權路徑照舊經 resolveSessionScope（ALL/COMPANY 運行時 DB 解析，唔靠呢個 snapshot）。
  let staffClinicIds: string[] = [];
  if (user.scopeType === "CLINICS") {
    const rows = await prisma.staffClinic.findMany({
      where: { staffId: user.id },
      select: { clinicId: true },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    staffClinicIds = rows.map((r) => r.clinicId);
  }
  const clinicIds = await resolveClinicIds({
    scopeType: user.scopeType as "ALL" | "COMPANY" | "CLINICS",
    scopeCompanyId: user.scopeCompanyId,
    staffClinicIds,
  });
  // primaryClinicId 語義逐位保持（UI default 店 / 通知分組）：
  //   CLINICS = StaffClinic 頭行；COMPANY = 公司店頭行；ALL = StaffUser.clinicId（snapshot 已係全店 — 唔可用 [0]）。
  const primaryClinicId =
    user.role === "STAFF" ? (user.scopeType === "ALL" ? user.clinicId : clinicIds[0] ?? user.clinicId) : null;

  const base = {
    staffId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    clinicId: primaryClinicId,
    clinicIds,
    // ★ cwi-hub-a-20260914（Part A）：公司層範圍 — login 由 StaffUser 寫入（session snapshot；
    //   admin 改 scope 下次 login 生效，同現行 clinicId 改動語義一致）。
    scopeType: user.scopeType as "ALL" | "COMPANY" | "CLINICS",
    scopeCompanyId: user.scopeCompanyId,
    loginAt: Date.now(),
    // ★ cwi-final S3-2（A1）：session sid — 登出只 deny 呢個 session（其他機唔受影響）
    sid: randomUUID(),
  };

  if (needsEnroll) {
    // ★ S3-5：enroll-only session（TTL 15 分鐘 — isSessionFresh 特判；requireAuth 除 /api/admin/totp/* 外 403）
    const res = await setSession(req, { ...base, enrollOnly: true });
    log.info({ staffId: user.id, role: user.role }, "login: success (enroll-only — TOTP 強制)");
    return new Response(JSON.stringify({ ok: true, needEnroll: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": res.headers.get("set-cookie") ?? "",
      },
    });
  }

  const res = await setSession(req, base);

  // ★ H-2 配套：AuditLog LOGIN（meta.ip）+ ADMIN 新 IP alert（fail-soft，唔阻登入）
  await recordLoginAudit(user.id, user.role, ip);

  log.info({ staffId: user.id, role: user.role }, "login: success");
  return new Response(JSON.stringify({ ok: true, redirect: "/inbox" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": res.headers.get("set-cookie") ?? "",
    },
  });
});
