import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
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
});

/** 每步失敗嘅統一回覆：{ step, httpStatus, error } */
function stepFail(step: string, httpStatus: number | null, error: string): NextResponse {
  return NextResponse.json({ step, httpStatus, error }, { status: httpStatus ?? 502 });
}

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req); // 無 session → 401；非 ADMIN → 403
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const { code, clinicId, phoneNumberId, wabaId, pin: bodyPin } = parsed.data;

  if (!phoneNumberId) return stepFail("input", 400, "phoneNumberId missing（Embedded Signup FINISH 未帶 phone_number_id）");
  const pin = bodyPin ?? process.env.WA_ES_PIN ?? "";
  if (!pin) return stepFail("input", 400, "pin missing（body.pin 或 env WA_ES_PIN；two-step PIN，記入 runbook 唔入 DB）");
  const mock = waMock();

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
        const res = await fetch(`${GRAPH_BASE}/${wabaId}/subscribed_apps`, {
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

  // ── Step 3: phone number register ────────────────────────────────────────────
  if (!mock) {
    try {
      const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/register`, {
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
  log.info({ mock }, "es-exchange: step3 phone register OK");

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

  // ── Step 5: 審計 ─────────────────────────────────────────────────────────────
  try {
    await prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "ES_ONBOARD",
        entity: "Clinic",
        entityId: clinicId,
        meta: { phoneNumberId, wabaId: wabaId ?? null },
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

  return NextResponse.json({ clinicCode, phoneNumberId, wabaId: wabaId ?? null });
});
