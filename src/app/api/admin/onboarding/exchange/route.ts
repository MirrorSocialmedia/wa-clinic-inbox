import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireGlobalAdmin } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { waMock } from "@/lib/wa/graph";
import log from "@/lib/log";
import { randomBytes } from "node:crypto";

/**
 * /api/admin/onboarding/exchange — WhatsApp Embedded Signup token exchange（App Review §2.3，ADMIN-only）。
 *
 * 步驟（MD §2.3）：
 *  1) GET  graph.facebook.com/v23.0/oauth/access_token?client_id=&client_secret=<WA_APP_SECRET>&code=
 *     → { access_token }（短用即棄；★ 零入 log）
 *  2) POST /v23.0/{wabaId}/subscribed_apps            （Bearer 上述 token）→ webhook 訂閱
 *  3) POST /v23.0/{phoneNumberId}/register  { messaging_product: "whatsapp", pin }
 *     pin = 該號 two-step PIN（body.pin 或 env WA_ES_PIN）；記入 runbook，★ 不入 DB、不入 log
 *  4) prisma.clinic.update → waPhoneNumberId
 *  5) AuditLog("ES_ONBOARD", clinicId)；回 { clinicCode, phoneNumberId, wabaId }
 *
 * ★ 共存模式（mode="coexistence"；Embedded Signup FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING）：
 *   號碼繼續喺 WhatsApp Business App 用 —
 *   - 唔做 step 3 register（register = 號碼離開 App）、唔使 pin
 *   - phone_number_id 可缺 → 用 waba_id GET /{waba}/phone_numbers 查返（只接受啱啱好一個號碼）
 *   - step 4 寫 clinic 之後先觸發同步（inbound worker 靠 clinic.waPhoneNumberId 分流 history / echoes）：
 *       POST /{phone}/smb_app_data { messaging_product:"whatsapp", sync_type:"smb_app_state_sync" }（聯絡人）
 *       POST /{phone}/smb_app_data { messaging_product:"whatsapp", sync_type:"history" }（舊對話）
 *     Meta 要求 onboarding 後 24 小時內做；同步失敗唔令 onboarding 失敗（回 sync 狀態，可用
 *     scripts/flow-publish-check.ts --coex-sync 重試）
 *
 * 每步 fail 回明確 { step, httpStatus, error } — onboarding 出事要一眼知卡邊步。
 * Mock mode（WA_MOCK=1）：step 1–3 走 mock 分支（無網絡），step 4–5 照寫 DB — e2e 行完整 flow。
 *
 * ★ PII/secret 鐵律：code / access_token / pin 絕不入 log（e2e 有 grep 自證）。
 */
export const dynamic = "force-dynamic";

const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const HTTP_TIMEOUT_MS = 10_000;

const bodySchema = z.object({
  code: z.string().min(8).max(4096), // auth code — 零入 log
  clinicId: z.string().min(1).max(64),
  phoneNumberId: z.string().min(1).max(64).optional(),
  wabaId: z.string().min(1).max(64).optional(),
  pin: z.string().regex(/^\d{4,8}$/).optional(), // two-step PIN — 零入 log、不入 DB
  mode: z.enum(["cloud", "coexistence"]).default("cloud"),
});

/** 每步失敗嘅統一回覆：{ step, httpStatus, error } */
function stepFail(step: string, httpStatus: number | null, error: string): NextResponse {
  return NextResponse.json({ step, httpStatus, error }, { status: httpStatus ?? 502 });
}

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireGlobalAdmin(req); // ★ cwi-final S3-1：onboarding exchange = 集團級（WABA 綁定）— global admin only
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const { code, clinicId, wabaId, pin: bodyPin, mode } = parsed.data;
  let phoneNumberId = parsed.data.phoneNumberId;
  const coex = mode === "coexistence";

  if (!phoneNumberId && !(coex && wabaId)) {
    return stepFail("input", 400, "phoneNumberId missing（Embedded Signup FINISH 未帶 phone_number_id；共存模式至少要 wabaId）");
  }
  const pin = bodyPin ?? process.env.WA_ES_PIN ?? "";
  if (!coex && !pin) return stepFail("input", 400, "pin missing（body.pin 或 env WA_ES_PIN；two-step PIN，記入 runbook 唔入 DB）");
  const mock = waMock();
  if (coex && !phoneNumberId && mock) return stepFail("resolve_phone", 400, "mock 模式共存要帶 phoneNumberId");

  // ── Step 1: token exchange（code → 短用即棄 access token）────────────────────
  let accessToken: string;
  if (mock) {
    accessToken = `mock-oat-${randomBytes(12).toString("hex")}`; // 短用即棄；★ 零入 log
  } else {
    const appId = process.env.NEXT_PUBLIC_FB_APP_ID ?? "";
    const appSecret = process.env.WA_APP_SECRET ?? "";
    if (!appId || !appSecret) {
      return stepFail("config", 500, "NEXT_PUBLIC_FB_APP_ID / WA_APP_SECRET 未設");
    }
    try {
      // ★ 只 log step + httpStatus；token / code 零入 log
      const res = await fetch(
        `${GRAPH_BASE}/oauth/access_token?${new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          code,
        })}`,
        { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }
      );
      const data = (await res.json().catch(() => null)) as
        | { access_token?: string; error?: { message?: string } }
        | null;
      if (!res.ok || !data?.access_token) {
        log.warn({ step: "token_exchange", httpStatus: res.status }, "es-exchange: token exchange FAILED");
        return stepFail("token_exchange", res.status, data?.error?.message ?? "unknown error");
      }
      accessToken = data.access_token;
    } catch (err) {
      return stepFail("token_exchange", null, err instanceof Error ? err.message : "network error");
    }
  }
  log.info({ mock }, "es-exchange: step1 token exchange OK");

  // ── Step 2: WABA subscribe（webhook 訂閱；FINISH_ONLY_WABA 情境可能無 wabaId → skip）──
  if (wabaId) {
    if (!mock) {
      try {
        const res = await fetch(`${GRAPH_BASE}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) {
          log.warn({ step: "subscribe_waba", httpStatus: res.status }, "es-exchange: WABA subscribe FAILED");
          return stepFail("subscribe_waba", res.status, `graph http ${res.status}`);
        }
      } catch (err) {
        return stepFail("subscribe_waba", null, err instanceof Error ? err.message : "network error");
      }
    }
    log.info({ mock, subscribed: true }, "es-exchange: step2 WABA subscribe OK");
  }

  // ── Step 2b（共存）：冇 phone_number_id → 用 waba_id 查（只接受一個號碼）──────────
  if (coex && !phoneNumberId && wabaId) {
    try {
      const res = await fetch(`${GRAPH_BASE}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = (data?.data ?? []).map((x) => x.id).filter((x): x is string => typeof x === "string" && /^\d{1,32}$/.test(x));
      if (!res.ok) return stepFail("resolve_phone", res.status, `graph http ${res.status}`);
      if (ids.length !== 1) return stepFail("resolve_phone", 409, `WABA 有 ${ids.length} 個號碼 — 唔知綁邊個（請喺 Meta 框揀號碼再試）`);
      phoneNumberId = ids[0];
    } catch (err) {
      return stepFail("resolve_phone", null, err instanceof Error ? err.message : "network error");
    }
  }
  if (!phoneNumberId) return stepFail("resolve_phone", 400, "phoneNumberId 搵唔到");

  // ── Step 3: phone number register（★ 共存唔做：register 會令號碼離開 WhatsApp Business App）──
  if (coex) {
    log.info({ mock }, "es-exchange: step3 skipped (coexistence — 號碼留喺 Business App)");
  } else if (!mock) {
    try {
      const res = await fetch(`${GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn({ step: "register_phone", httpStatus: res.status }, "es-exchange: phone register FAILED");
        return stepFail("register_phone", res.status, `graph http ${res.status}`);
      }
    } catch (err) {
      return stepFail("register_phone", null, err instanceof Error ? err.message : "network error");
    }
  }
  if (!coex) log.info({ mock }, "es-exchange: step3 phone register OK");

  // ── Step 4: 寫入 clinic.waPhoneNumberId ──────────────────────────────────────
  let clinicCode: string;
  try {
    const clinic = await prisma.clinic.update({
      where: { id: clinicId },
      data: { waPhoneNumberId: phoneNumberId },
      select: { code: true },
    });
    clinicCode = clinic.code;
  } catch (err) {
    const perr = err as { code?: string };
    if (perr?.code === "P2025") return stepFail("db_update", 404, "clinic not found");
    if (perr instanceof Prisma.PrismaClientKnownRequestError && perr.code === "P2002") {
      return stepFail("db_update", 409, "waPhoneNumberId 已被其他 clinic 使用");
    }
    return stepFail("db_update", 500, "db update failed");
  }
  log.info({ clinicId, clinicCode }, "es-exchange: step4 clinic.waPhoneNumberId updated");

  // ── Step 4b（共存）：同步聯絡人 + 舊對話（clinic 已綁號碼 → history / echoes webhook 分流得到）──
  const sync: Record<string, string> = {};
  if (coex) {
    for (const [key, syncType] of [["contacts", "smb_app_state_sync"], ["history", "history"]] as const) {
      if (mock) {
        sync[key] = "mock";
        continue;
      }
      try {
        const res = await fetch(`${GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}/smb_app_data`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", sync_type: syncType }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        sync[key] = res.ok ? "ok" : `http ${res.status}`;
        if (!res.ok) log.warn({ step: `sync_${key}`, httpStatus: res.status }, "es-exchange: coexistence sync FAILED（24 小時內可重試）");
      } catch (err) {
        sync[key] = err instanceof Error ? err.message.slice(0, 80) : "network error";
      }
    }
    log.info({ mock, sync }, "es-exchange: step4b coexistence sync requested");
  }

  // ── Step 5: 審計 ─────────────────────────────────────────────────────────────
  try {
    await prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "ES_ONBOARD",
        entity: "Clinic",
        entityId: clinicId,
        meta: { phoneNumberId, wabaId: wabaId ?? null, mode, ...(coex ? { sync } : {}) },
      },
    });
  } catch (err) {
    // 審計失敗唔好令整單失敗（clinic 已更新）— 但照約回報
    log.error(
      { clinicId, err: err instanceof Error ? err.message : String(err) },
      "es-exchange: audit log FAILED"
    );
    return stepFail("audit_log", 500, "audit log failed（clinic 已更新，重試前請人工核對）");
  }
  log.info({ clinicCode }, "es-exchange: complete");

  return NextResponse.json({ clinicCode, phoneNumberId, wabaId: wabaId ?? null, mode, ...(coex ? { sync } : {}) });
});
