/**
 * WhatsApp Flow data_exchange endpoint（MD §8.2）
 *
 * WhatsApp（或 mock client）POST 過嚟 — **唔使 session auth**（同 webhook 一樣係
 * 外部端點）：身份靠 ① RSA 私鑰解鎖 ② flow_token JWT（簽 conversationId+clinicId，
 * 防別店/別對話用）③ FlowSession 狀態（SENT 先收）④ wa_id/phone_number_id 對照。
 *
 * 三步：SCREEN_PROVIDER → SCREEN_DATE（聽日~+30，只回有空日）→ SCREEN_TIME
 *（只回空 slot）— 每次 call 先經 getSlots()（四層降級鏈）確保 L2 新鮮。
 *
 * 降級（switch MD §3）：
 * - degraded ∈ {OK, STALE_SOURCE, STALE_CACHE} → 照出時段選項（response 帶 note 標記）
 * - degraded = NONE（API fail + 無 L2 cache）→ 「純收需求」變體：
 *   SCREEN_DATE / SCREEN_TIME 回 REQUIREMENT screen（DatePicker + 上晝/下晝/夜晚 RadioButtons），
 *   唔列時段；病人 Complete 時 BookingRequest.precheckPassed = null（卡灰字「未經空檔核對」）。
 *
 * 加密（MD §8.2 樣板）：
 *   request：RSA-OAEP(SHA-256) unwrap AES key → AES-128-GCM 解 body
 *   response：同一把 AES key + ★★ 反轉 IV
 *
 * 錯誤處理：任何一步失敗 → 4xx/5xx plaintext JSON（唔 crash、唔洩 PII）。
 */
import { NextRequest, NextResponse } from "next/server";
import log from "@/lib/log";
import prisma from "@/lib/prisma";
import {
  ensureKeypair,
  unwrapAesKey,
  decryptGcm,
  encryptGcm,
  reversedIv,
  verifyFlowToken,
  flowJwtSecret,
} from "@/lib/flows/crypto";
import { screenProviders, screenDates, screenTimes } from "@/lib/flows/screens";
import { syncWindow, getSlots } from "@/lib/availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["SCREEN_PROVIDER", "SCREEN_DATE", "SCREEN_TIME"] as const;

interface DecryptedRequest {
  action?: string;
  flow_token?: string;
  providerId?: string;
  date?: string;
}

function err(status: number, code: string) {
  return NextResponse.json({ error: code }, { status });
}

export async function POST(req: NextRequest) {
  try {
    // 1) 結構檢查
    const body = (await req.json().catch(() => null)) as
      | {
          phone_number_id?: string;
          wa_id?: string;
          data_exchange?: {
            encrypted?: { payload?: string; iv?: string; key_id?: string; wrapped_key?: string };
          };
        }
      | null;
    const enc = body?.data_exchange?.encrypted;
    if (!body?.phone_number_id || !body?.wa_id || !enc?.payload || !enc?.iv || !enc?.key_id || !enc?.wrapped_key) {
      return err(400, "bad_request_shape");
    }

    // 2) keypair + kid 對照
    const kp = ensureKeypair();
    if (enc.key_id !== kp.kid) return err(400, "unknown_key_id");

    // 3) 解 AES key（RSA-OAEP SHA-256）+ 解 body（AES-128-GCM）
    let key16: Buffer;
    let plain: DecryptedRequest;
    try {
      key16 = unwrapAesKey(kp.privatePem, enc.wrapped_key);
      const plainStr = decryptGcm(key16, enc.iv, enc.payload);
      plain = JSON.parse(plainStr) as DecryptedRequest;
    } catch {
      log.warn({ phone: body.phone_number_id }, "flow endpoint: decrypt failed");
      return err(400, "decrypt_failed");
    }

    const action = plain.action;
    if (!action || !(ACTIONS as readonly string[]).includes(action)) return err(400, "bad_action");

    // 4) flow_token 驗證（簽 conversationId+clinicId 嘅 JWT — 防別店/別對話用）
    let secret: string;
    try {
      secret = flowJwtSecret();
    } catch {
      log.error("flow endpoint: FLOW_JWT_SECRET missing");
      return err(500, "misconfigured");
    }
    const tokenPayload = plain.flow_token ? verifyFlowToken(plain.flow_token, secret) : null;
    if (!tokenPayload) {
      log.warn({ phone: body.phone_number_id }, "flow endpoint: invalid flow_token");
      return err(401, "invalid_flow_token");
    }

    // 5) FlowSession 對照（token 必須對應一個 SENT 中嘅 flow）
    const session = await prisma.flowSession.findUnique({ where: { flowToken: plain.flow_token! } });
    if (!session || session.status !== "SENT" || session.conversationId !== tokenPayload.convId || session.clinicId !== tokenPayload.clinicId) {
      log.warn({ convId: tokenPayload.convId }, "flow endpoint: flow_token 無對應 SENT session");
      return err(401, "invalid_flow_token");
    }

    // 6) 對話 / 店 / wa_id / phone_number_id 對照（防別號用呢個 token）
    const conv = await prisma.conversation.findUnique({ where: { id: tokenPayload.convId } });
    if (!conv || conv.clinicId !== tokenPayload.clinicId) return err(401, "invalid_flow_token");
    const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId } });
    if (!clinic) return err(500, "misconfigured");
    const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
    if (contact?.waId !== body.wa_id) {
      log.warn({ convId: conv.id }, "flow endpoint: wa_id mismatch");
      return err(403, "conversation_mismatch");
    }
    if (clinic.waPhoneNumberId !== body.phone_number_id) {
      log.warn({ convId: conv.id }, "flow endpoint: phone_number_id mismatch");
      return err(403, "conversation_mismatch");
    }

    // 7) 逐 screen 處理（每次先經 getSlots 確保 L2 新鮮 — precheck 原則 + 四層降級鏈）
    let data: unknown;
    let nextAction: string;
    let note: string | undefined;
    const clinicId = clinic.id;

    const slotRes = await getSlots(clinicId);
    if (slotRes.degraded === "STALE_SOURCE") {
      note = "資料源 stale（使用最後已知空檔）";
    } else if (slotRes.degraded === "STALE_CACHE") {
      note = "資料源離線（使用緩存空檔）";
    }

    if (action === "SCREEN_PROVIDER") {
      data = await screenProviders(clinicId);
      nextAction = "SCREEN_DATE";
    } else if (action === "SCREEN_DATE") {
      const providerId = String(plain.providerId ?? "");
      const providers = await screenProviders(clinicId);
      if (!providerId || !providers.some((p) => p.id === providerId)) return err(400, "invalid_provider");
      if (slotRes.degraded === "NONE") {
        // 純收需求變體：唔列時段 — DatePicker（窗口內）+ 時段偏好 RadioButtons
        data = {
          mode: "requirement",
          dateStart: slotRes.window.start,
          dateEnd: slotRes.window.end,
          timeOfDayOptions: ["MORNING", "AFTERNOON", "EVENING"],
          note: "未經空檔核對（資料源離線）",
          degraded: "NONE",
        };
        nextAction = "REQUIREMENT";
      } else {
        data = await screenDates(clinicId, providerId);
        nextAction = "SCREEN_TIME";
      }
    } else {
      const providerId = String(plain.providerId ?? "");
      const date = String(plain.date ?? "");
      const providers = await screenProviders(clinicId);
      if (!providerId || !providers.some((p) => p.id === providerId)) return err(400, "invalid_provider");
      const { start, end } = syncWindow();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || date > end) return err(400, "invalid_date");
      if (slotRes.degraded === "NONE") {
        // 純收需求變體（同 SCREEN_DATE — 客戶端可能直跳呢步）
        data = {
          mode: "requirement",
          dateStart: slotRes.window.start,
          dateEnd: slotRes.window.end,
          timeOfDayOptions: ["MORNING", "AFTERNOON", "EVENING"],
          note: "未經空檔核對（資料源離線）",
          degraded: "NONE",
        };
        nextAction = "REQUIREMENT";
      } else {
        data = await screenTimes(clinicId, providerId, date);
        nextAction = "COMPLETE";
      }
    }

    // 8) 加密 response（同一把 AES key + ★ 反轉 IV）
    const respIv = reversedIv(enc.iv);
    const { payload, iv } = encryptGcm(key16, respIv, {
      action: nextAction,
      data,
      data_count: Array.isArray(data) ? data.length : 0,
      ...(note ? { note } : {}),
    });

    log.info(
      {
        clinic: clinic.code,
        action,
        nextAction,
        options: Array.isArray(data) ? data.length : 0,
        degraded: slotRes.degraded,
        convId: conv.id,
      },
      "flow endpoint: data_exchange ok"
    );

    return NextResponse.json({
      response_json: { payload, iv, key_id: kp.kid },
    });
  } catch (e) {
    // 萬一：未預期錯誤 → 500（唔洩內部細節）
    log.error({ err: e instanceof Error ? e.message : String(e) }, "flow endpoint: unexpected error");
    return err(500, "internal_error");
  }
}

/**
 * 健康檢查（mock E2E / 排錯用）：回 kid + keys dir。
 * GET /api/flows/endpoint?key=healthz → { kid, ok: true }
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("key") !== "healthz") return err(404, "not_found");
  const kp = ensureKeypair();
  return NextResponse.json({ ok: true, kid: kp.kid });
}
