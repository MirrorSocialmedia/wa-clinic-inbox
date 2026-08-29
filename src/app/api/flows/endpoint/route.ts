/**
 * WhatsApp Flow data_exchange endpoint（MD §8.2 + cwi-r2 2026-08-27 生產真 spec 雙信封）
 *
 * WhatsApp（或 mock client）POST 過嚟 — **唔使 session auth**（同 webhook 一樣係
 * 外部端點）：身份靠 ① RSA 私鑰解鎖 ② flow_token JWT（簽 conversationId+clinicId，
 * 防別店/別對話用）③ FlowSession 狀態（SENT 先收）④ wa_id/phone_number_id 對照
 *（legacy 信封先有）。
 *
 * ══ 雙信封（cwi-r2）══
 * **生產真 spec（Meta 2026 data endpoint）**：
 *   request  = { encrypted_flow_data, encrypted_aes_key, initial_vector }
 *     - 明文 = { version:"3.0", action: INIT|data_exchange|BACK, screen, data, flow_token }
 *     - 無 key_id / 無 wa_id / 無 phone_number_id → 身份 = RSA unwrap + flow_token JWT + FlowSession
 *   response = text/plain base64(AES-GCM ciphertext‖tag)，明文 =
 *     { version:"3.0", screen, data } 或 SUCCESS：
 *     { version:"3.0", screen:"SUCCESS", data:{ extension_message_response:{ params } } }
 *     - 同一把 AES key + ★ IV bitwise-NOT 取反（同 legacy）
 *
 * **Legacy 信封（mock client / 舊 canvas 三 screen contract — e2e 回歸用）**：
 *   request  = { phone_number_id, wa_id, data_exchange:{ encrypted:{ payload, iv, key_id, wrapped_key } } }
 *     - 明文 = { action: SCREEN_PROVIDER|SCREEN_DATE|SCREEN_TIME, flow_token, providerId?, date? }
 *   response = { response_json:{ payload, iv, key_id } }，明文 = { action, data, data_count, note? }
 *
 * ══ 新 spec 三屏流（MD §B3 — stateless：每步 data_exchange payload 帶齊上下文）══
 *   INIT → SCR_DATE（date picker，min=今日 max=+30）
 *   SCR_DATE  submit_date     → 查 availability → SCR_SLOT（醫生 radio + 時段 radio，動態 options）
 *   SCR_SLOT  submit_slot     → 驗證 (provider,date,time) 組合 → SCR_CONFIRM（姓名預填 profileName + 備註）
 *   SCR_CONFIRM submit_confirm → 最終重驗 L2 → SUCCESS（params 入 nfm_reply → worker flow-reply.ts
 *     pipeline 照舊 — 三掣卡寫入路徑零改動；capacity 候選過濾 + submit 重驗 + checkClash 三層）
 *
 * 降級（switch MD §3）：
 * - degraded ∈ {null, STALE_SOURCE, STALE_CACHE} → 照出時段選項
 * - degraded = NONE（API fail + 無 L2 cache）→ 新 spec 回 error_message 留日期屏
 *   （純收需求 requirement 變體只行舊 canvas FLOW_REQ_*，本輪唔改）
 *
 * 加密（MD §8.2 樣板 — crypto.ts 原語同 Meta 官方 spec 全對齊）：
 *   RSA-OAEP(SHA-256) unwrap AES-128 key → AES-128-GCM（ciphertext‖tag）→ response IV bitwise-NOT 取反
 *
 * 錯誤處理：認證/結構問題 → 4xx/5xx plaintext JSON；業務驗證失敗 → HTTP 200 +
 * error_message 留原屏（Meta 規則：唔好靠 4xx 傳驗證錯誤）。
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
import {
  screenProviders,
  screenDates,
  screenTimes,
  dateOptionsFromSlots,
  dateScreenData,
  slotScreenData,
  confirmScreenData,
  type ProviderOption,
} from "@/lib/flows/screens";
import {
  syncWindow,
  getSlots,
  hkTodayStr,
  hkDateOffset,
  slotAvailable,
  type SlotRow,
} from "@/lib/availability";
import { fmtDateFull } from "@/lib/booking/session-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEGACY_ACTIONS = ["SCREEN_PROVIDER", "SCREEN_DATE", "SCREEN_TIME"] as const;
const NEW_ACTIONS = ["INIT", "data_exchange", "BACK"] as const;
const DATA_API_VERSION = "3.0";

const SCREEN_DATE = "SCR_DATE";
const SCREEN_SLOT = "SCR_SLOT";
const SCREEN_CONFIRM = "SCR_CONFIRM";

interface DecryptedRequest {
  action?: string;
  flow_token?: string;
  providerId?: string;
  date?: string;
  screen?: string;
  data?: Record<string, unknown>;
}

function err(status: number, code: string) {
  return NextResponse.json({ error: code }, { status });
}

// ── 生產真 spec response（text/plain encrypted） ─────────────────────────

function prodResp(key16: Buffer, reqIvB64: string, screen: string, data: object): NextResponse {
  const { payload } = encryptGcm(key16, reversedIv(reqIvB64), { version: DATA_API_VERSION, screen, data });
  return new NextResponse(payload, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function prodSuccess(key16: Buffer, reqIvB64: string, params: Record<string, unknown>): NextResponse {
  return prodResp(key16, reqIvB64, "SUCCESS", { extension_message_response: { params } });
}

// ── 新 spec helpers（stateless — 每步 payload 帶齊上下文） ───────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function dateRangeError(date: string): string | null {
  if (!DATE_RE.test(date)) return "日期格式有誤，請重揀";
  const min = hkTodayStr();
  const max = hkDateOffset(30);
  if (date < min || date > max) return "請揀今日至 30 日內嘅日期";
  return null;
}

/** 該日可用 slot 行（§D capacity filter — slotAvailable 統一 predicate）。 */
function openRowsForDate(slots: SlotRow[] | null, date: string): SlotRow[] {
  return (slots ?? []).filter((r) => r.date === date && slotAvailable(r));
}

/**
 * 由 (date, rows) 砌 SCR_SLOT data（doctor radio + time radio options）。
 * 零可用 slot → 回 null（caller 轉回 SCR_DATE + 該日無空檔 error）。
 */
function buildSlotData(
  date: string,
  rows: SlotRow[],
  providers: ProviderOption[],
  error: string,
): ReturnType<typeof slotScreenData> | null {
  const openProviders = providers.filter((p) => rows.some((r) => r.providerApricotId === p.id));
  const times = [...new Set(rows.map((r) => r.startTime))].sort();
  if (openProviders.length === 0 || times.length === 0) return null;
  return slotScreenData({ date, providers: openProviders, times, error });
}

export async function POST(req: NextRequest) {
  let key16: Buffer;
  let reqIvB64: string;
  let plain: DecryptedRequest;
  let envelope: "prod" | "legacy";

  try {
    // 1) 結構檢查 + 信封偵測
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(400, "bad_request_shape");

    const enc = (body.data_exchange as { encrypted?: { payload?: string; iv?: string; key_id?: string; wrapped_key?: string } } | undefined)?.encrypted;
    const phoneId = body.phone_number_id as string | undefined;
    const waId = body.wa_id as string | undefined;

    if (typeof body.encrypted_flow_data === "string" && typeof body.encrypted_aes_key === "string" && typeof body.initial_vector === "string") {
      // ── 生產真 spec 信封 ──
      envelope = "prod";
      const kp = ensureKeypair();
      try {
        key16 = unwrapAesKey(kp.privatePem, body.encrypted_aes_key);
        plain = JSON.parse(decryptGcm(key16, body.initial_vector, body.encrypted_flow_data)) as DecryptedRequest;
      } catch {
        log.warn("flow endpoint: decrypt failed (prod)");
        return err(400, "decrypt_failed");
      }
      reqIvB64 = body.initial_vector;
    } else if (phoneId && waId && enc?.payload && enc.iv && enc.key_id && enc.wrapped_key) {
      // ── legacy 信封（mock client / 舊 canvas） ──
      envelope = "legacy";
      const kp = ensureKeypair();
      if (enc.key_id !== kp.kid) return err(400, "unknown_key_id");
      try {
        key16 = unwrapAesKey(kp.privatePem, enc.wrapped_key);
        plain = JSON.parse(decryptGcm(key16, enc.iv, enc.payload)) as DecryptedRequest;
      } catch {
        log.warn({ phone: phoneId }, "flow endpoint: decrypt failed (legacy)");
        return err(400, "decrypt_failed");
      }
      reqIvB64 = enc.iv;
    } else {
      return err(400, "bad_request_shape");
    }

    const action = plain.action;
    if (!action) return err(400, "bad_action");

    // 2a) ping / error_notification：WhatsApp 平台層心跳／錯誤通知 — 無 flow_token 放行
    //     （靜態 data 回應：零 PII / 零寫入 / 零 DB — by design；screen 欄 = action 名自描述）
    if (action === "ping" || action === "error_notification") {
      const data = action === "ping" ? { status: "active" } : { acknowledged: true };
      return prodResp(key16, reqIvB64, action, data);
    }

    // 2) flow_token 驗證（簽 conversationId+clinicId 嘅 JWT — 防別店/別對話用）
    let secret: string;
    try {
      secret = flowJwtSecret();
    } catch {
      log.error("flow endpoint: FLOW_JWT_SECRET missing");
      return err(500, "misconfigured");
    }
    const tokenPayload = plain.flow_token ? verifyFlowToken(plain.flow_token, secret) : null;
    if (!tokenPayload) {
      log.warn("flow endpoint: invalid flow_token");
      return err(401, "invalid_flow_token");
    }

    // 3) FlowSession 對照（token 必須對應一個 SENT 中嘅 flow）
    const session = await prisma.flowSession.findUnique({ where: { flowToken: plain.flow_token! } });
    if (!session || session.status !== "SENT" || session.conversationId !== tokenPayload.convId || session.clinicId !== tokenPayload.clinicId) {
      log.warn({ convId: tokenPayload.convId }, "flow endpoint: flow_token 無對應 SENT session");
      return err(401, "invalid_flow_token");
    }

    // 4) 對話 / 店 對照
    const conv = await prisma.conversation.findUnique({ where: { id: tokenPayload.convId } });
    if (!conv || conv.clinicId !== tokenPayload.clinicId) return err(401, "invalid_flow_token");
    const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId } });
    if (!clinic) return err(500, "misconfigured");
    const contact = await prisma.contact.findUnique({ where: { id: conv.contactId }, select: { waId: true, profileName: true } });

    // 5) legacy 信封先有 wa_id / phone_number_id → 對照（防別號用呢個 token）
    if (envelope === "legacy") {
      if (contact?.waId !== waId) {
        log.warn({ convId: conv.id }, "flow endpoint: wa_id mismatch");
        return err(403, "conversation_mismatch");
      }
      if (clinic.waPhoneNumberId !== phoneId) {
        log.warn({ convId: conv.id }, "flow endpoint: phone_number_id mismatch");
        return err(403, "conversation_mismatch");
      }
    }

    const clinicId = clinic.id;
    const profileName = contact?.profileName ?? "";

    // ══ 分支 A：生產真 spec（INIT / data_exchange / BACK） ══
    if (envelope === "prod") {
      if (!(NEW_ACTIONS as readonly string[]).includes(action)) return err(400, "bad_action");

      // 每次 call 先經 getSlots()（四層降級鏈）確保 L2 新鮮（precheck 原則 — 病人揀親 = 真有空）
      const slotRes = await getSlots(clinicId);

      // INIT（開 Flow）→ 日期屏（v2：dates[] = 30 日內有空檔日，Dropdown options）
      if (action === "INIT") {
        log.info({ clinic: clinic.code, degraded: slotRes.degraded, convId: conv.id }, "flow endpoint: INIT → SCR_DATE");
        return prodResp(key16, reqIvB64, SCREEN_DATE, dateScreenData({ degraded: slotRes.degraded, dates: dateOptionsFromSlots(slotRes.slots) }));
      }

      // BACK（refresh_on_back=false → 正常唔會到；到咗就穩陣返日期屏重算）
      if (action === "BACK") {
        log.info({ clinic: clinic.code, screen: plain.screen, convId: conv.id }, "flow endpoint: BACK → SCR_DATE");
        return prodResp(key16, reqIvB64, SCREEN_DATE, dateScreenData({ degraded: slotRes.degraded, dates: dateOptionsFromSlots(slotRes.slots) }));
      }

      // data_exchange — 由 data.user_action 分支（屏級意圖；唔用 "action" 名 — Meta 會 collision）
      const d = plain.data ?? {};
      const userAction = typeof d.user_action === "string" ? d.user_action : "";
      if (!userAction) return err(400, "bad_user_action");

      // ── submit_date：日期 → 醫生/時段 options ──
      if (userAction === "submit_date") {
        const date = String(d.date ?? "");
        const rangeErr = dateRangeError(date);
        if (rangeErr || slotRes.degraded === "NONE") {
          const msg =
            slotRes.degraded === "NONE"
              ? "預約系統暫時唔到，請稍後再試"
              : (rangeErr ?? "日期有誤，請重揀");
          log.info({ clinic: clinic.code, date, error: msg, convId: conv.id }, "flow endpoint: submit_date → stay SCR_DATE");
          return prodResp(key16, reqIvB64, SCREEN_DATE, {
            ...dateScreenData({ degraded: slotRes.degraded, dates: dateOptionsFromSlots(slotRes.slots) }),
            has_error: true,
            error_message: msg,
          });
        }
        const rows = openRowsForDate(slotRes.slots, date);
        const providers = await screenProviders(clinicId);
        const slotData = buildSlotData(date, rows, providers, "");
        if (!slotData) {
          log.info({ clinic: clinic.code, date, convId: conv.id }, "flow endpoint: submit_date → 該日無空檔");
          return prodResp(key16, reqIvB64, SCREEN_DATE, {
            ...dateScreenData({ degraded: slotRes.degraded, dates: dateOptionsFromSlots(slotRes.slots) }),
            has_error: true,
            error_message: "呢日冇空檔，請揀其他日期",
          });
        }
        log.info({ clinic: clinic.code, date, providers: slotData.providers.length, times: slotData.times.length, degraded: slotRes.degraded, convId: conv.id }, "flow endpoint: submit_date → SCR_SLOT");
        return prodResp(key16, reqIvB64, SCREEN_SLOT, slotData);
      }

      // ── submit_slot：醫生+時段 組合驗證 → 確認屏 ──
      if (userAction === "submit_slot") {
        const date = String(d.date ?? "");
        const providerId = String(d.provider_id ?? "");
        const time = String(d.time ?? "");
        const providers = await screenProviders(clinicId);
        const provider = providers.find((p) => p.id === providerId);
        const rangeErr = dateRangeError(date);
        if (rangeErr || !provider || !TIME_RE.test(time) || slotRes.degraded === "NONE") {
          const msg =
            slotRes.degraded === "NONE"
              ? "預約系統暫時唔到，請稍後再試"
              : "資料有誤，請返回重揀";
          log.info({ clinic: clinic.code, date, providerId, error: msg, convId: conv.id }, "flow endpoint: submit_slot → error");
          return slotErrorResp(clinicId, key16, reqIvB64, date, slotRes, msg);
        }
        const rows = openRowsForDate(slotRes.slots, date);
        const slot = rows.find((r) => r.providerApricotId === providerId && r.startTime === time);
        if (!slot) {
          // 組合唔成立（該醫生呢個時間冇開 / 滿位）→ 留 SCR_SLOT 重揀
          log.info({ clinic: clinic.code, date, providerId, time, convId: conv.id }, "flow endpoint: submit_slot → 組合唔成立，留 SCR_SLOT");
          return slotErrorResp(clinicId, key16, reqIvB64, date, slotRes, "呢個時間該醫生冇開診，請揀其他時間");
        }
        log.info({ clinic: clinic.code, date, providerId, time, convId: conv.id }, "flow endpoint: submit_slot → SCR_CONFIRM");
        return prodResp(key16, reqIvB64, SCREEN_CONFIRM, confirmScreenData({ date, providerId, providerName: provider.name, time, profileName }));
      }

      // ── submit_confirm：最終重驗 L2 → SUCCESS（params 入 nfm_reply） ──
      if (userAction === "submit_confirm") {
        const date = String(d.date ?? "");
        const providerId = String(d.provider_id ?? "");
        const time = String(d.time ?? "");
        const name = String(d.name ?? "").trim();
        const notes = String(d.notes ?? "").slice(0, 200);
        const providers = await screenProviders(clinicId);
        const provider = providers.find((p) => p.id === providerId);
        const rangeErr = dateRangeError(date);
        if (rangeErr || !provider || !TIME_RE.test(time) || !name || name.length > 40) {
          log.info({ clinic: clinic.code, date, providerId, nameLen: name.length, error: "bad_payload", convId: conv.id }, "flow endpoint: submit_confirm → bad payload");
          return confirmErrorResp(clinicId, key16, reqIvB64, date, providerId, time, profileName, "資料有誤，請返回重揀");
        }
        // ★ 最終防線之一：L2 重驗（病人揀親 = 真有空）— capacity 候選過濾 + 呢度重驗 +
        //   flow-reply precheck + 寫入時 checkClash（兩層唔合併，照舊）
        const rows = openRowsForDate(slotRes.slots, date);
        const slot = rows.find((r) => r.providerApricotId === providerId && r.startTime === time);
        if (!slot) {
          log.info({ clinic: clinic.code, date, providerId, time, convId: conv.id }, "flow endpoint: submit_confirm → slot 已滿，留 SCR_CONFIRM");
          return confirmErrorResp(clinicId, key16, reqIvB64, date, providerId, time, profileName, "呢個時段剛好被人預約咗，請返回重揀");
        }
        log.info({ clinic: clinic.code, date, providerId, time, nameLen: name.length, notesLen: notes.length, convId: conv.id }, "flow endpoint: submit_confirm → SUCCESS");
        return prodSuccess(key16, reqIvB64, {
          flow_token: plain.flow_token,
          providerId,
          providerName: provider.name,
          date,
          time,
          name,
          notes,
        });
      }

      return err(400, "bad_user_action");
    }

    // ══ 分支 B：legacy 信封（舊 canvas 三 action — e2e 回歸用，行為零改動） ══
    if (!(LEGACY_ACTIONS as readonly string[]).includes(action)) return err(400, "bad_action");

    let data: unknown;
    let nextAction: string;
    let note: string | undefined;

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
      if (!DATE_RE.test(date) || date < start || date > end) return err(400, "invalid_date");
      if (slotRes.degraded === "NONE") {
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

    // 8) 加密 response（同一把 AES key + ★ IV bitwise-NOT 取反）
    const { payload, iv } = encryptGcm(key16, reversedIv(reqIvB64), {
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
      "flow endpoint: data_exchange ok (legacy)"
    );

    return NextResponse.json({
      response_json: { payload, iv, key_id: ensureKeypair().kid },
    });
  } catch (e) {
    // 萬一：未預期錯誤 → 500（唔洩內部細節）
    log.error({ err: e instanceof Error ? e.message : String(e) }, "flow endpoint: unexpected error");
    return err(500, "internal_error");
  }
}

// ── 新 spec 錯誤重渲染（留原屏 + error_message） ─────────────────────────

async function slotErrorResp(
  clinicId: string,
  key16: Buffer,
  reqIvB64: string,
  date: string,
  slotRes: Awaited<ReturnType<typeof getSlots>>,
  msg: string,
): Promise<NextResponse> {
  // 穩陣：重算該屏 data（若該日已全滿 → 跌返日期屏）
  if (!dateRangeError(date) && slotRes.degraded !== "NONE") {
    const rows = openRowsForDate(slotRes.slots, date);
    const providers = await screenProviders(clinicId);
    const slotData = buildSlotData(date, rows, providers, msg);
    if (slotData) return prodResp(key16, reqIvB64, SCREEN_SLOT, slotData);
  }
  return prodResp(key16, reqIvB64, SCREEN_DATE, {
    ...dateScreenData({ degraded: slotRes.degraded, dates: dateOptionsFromSlots(slotRes.slots) }),
    has_error: true,
    error_message: msg,
  });
}

async function confirmErrorResp(
  clinicId: string,
  key16: Buffer,
  reqIvB64: string,
  date: string,
  providerId: string,
  time: string,
  profileName: string,
  msg: string,
): Promise<NextResponse> {
  const providers = await screenProviders(clinicId);
  const provider = providers.find((p) => p.id === providerId);
  return prodResp(
    key16,
    reqIvB64,
    SCREEN_CONFIRM,
    confirmScreenData({ date, providerId, providerName: provider?.name ?? "（醫生）", time, profileName, error: msg }),
  );
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
