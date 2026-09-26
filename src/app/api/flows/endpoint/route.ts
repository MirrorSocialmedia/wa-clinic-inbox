/**
 * WhatsApp Flow data_exchange endpoint（MD §8.2 + cwi-r2 2026-08-27 生產真 spec 雙信封）
 *
 * WhatsApp（或 mock client）POST 過嚟 — **唔使 session auth**（同 webhook 一樣係
 * 外部端點）：身份靠 ⓪ x-hub-signature-256（S3-8，HMAC WA_APP_SECRET，同 webhook 一致）
 * ① RSA 私鑰解鎖 ② flow_token JWT（簽 conversationId+clinicId，S3-8 加 24h exp，
 * 防別店/別對話用）③ FlowSession 狀態（SENT 先收）④ wa_id/phone_number_id 對照
 *（legacy 信封先有）。
 *
 * 傳輸層錯誤代碼（S3-8）：432 無/錯簽名；421 decrypt 失敗；427 token 無效/過期。
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
 * ══ 新 spec 三屏流（MD §B3/T4 — stateless：每步 data_exchange payload 帶齊上下文）══
 *   INIT → SCR_DATE（date picker，min=今日 max=+30）
 *   SCR_DATE  submit_date     → workforce bookable-slots → SCR_SLOT（醫生 radio + 時段 radio，
 *                              provider_id = workforce 簽發真 cuid；slotKey 不透明）
 *   SCR_SLOT  submit_slot     → 驗證 (provider,date,time) 組合（bookable 源）→ SCR_CONFIRM
 *   SCR_CONFIRM submit_confirm → ★ claim 時機（MD §3.2）：佔位硬保留（workforce ProviderHold）
 *     → inbox FlowHoldEvent（T3 預約卡「線上已佔·等你入 Apricot」）→ SUCCESS（params 帶
 *     holdId 自描述 → nfm_reply flow-reply claimed 變體：唔行 L2 precheck、唔建 BookingRequest）
 *   409 slot_taken → 重拉最新 bookable → SCR_SLOT 重導（病人揀另一格）
 *   降級：bookable API fail → 日期屏 error（同舊 NONE 語義）
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
  confirmScreenData,
  bookableDateScreen,
  slotScreenDataPaged,
} from "@/lib/flows/screens";
import { syncWindow, getSlots, hkTodayStr, hkDateOffset } from "@/lib/availability";
import { getBookableSlots, claimSlot, filterBookableSlots, WorkforceApiError, refreshAvailability, slotClaimEnabled, type BookableDay, type BookableSlot } from "@/lib/workforce/client";
import { getSlotDayFreshness, invalidateAvailabilityDay } from "@/lib/availability";
import { hit, clientIpFromHeaders } from "@/lib/rate-limit";
import { verifyWaSignature } from "@/lib/wa-signature";
import { publishConvEvent, convRef } from "@/lib/notify";

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

// ── ★ cwi-final S5-9（audit3 P1-13）：submit_confirm 成功即 FlowSession COMPLETED ──
// 真機實錘：nfm_reply 係明文且到達唔保證（加密只喺 data_exchange endpoint）—
// 唔可以依賴 nfm_reply 先完成 session，否則 session 永遠 SENT → 再撳 📅 重用舊 flow、
// 病人無法開新預約。claim 成功（含冪等 replay）時立即標 COMPLETED（best-effort，唔 throw）。
async function completeFlowSession(sessionId: string, convId: string, holdId: string | null, reason: string): Promise<void> {
  try {
    await prisma.flowSession.update({ where: { id: sessionId }, data: { status: "COMPLETED", completedAt: new Date() } });
    log.info({ convId, holdId, reason }, "flow endpoint: FlowSession COMPLETED（S5-9 — 唔依賴 nfm_reply）");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), convId }, "flow endpoint: session COMPLETED 寫入失敗（best-effort）");
  }
}

// 改期 context 副作用（S5-9 移去 claim 時）：清 conv.reschedulingApptId 旗標 + StaffNotice。
// 冪等鍵 = 旗標本身（updateMany where 對住舊值）：第一次清返 count=1 先建 notice；
// flow-reply claimed 分支（endpoint 標 COMPLETED 失敗嘅 fallback）再行時旗標已清 → 唔雙發。
async function applyRescheduleContext(convId: string, clinicId: string, oldApptId: string, holdId: string): Promise<void> {
  try {
    const cleared = await prisma.conversation.updateMany({
      where: { id: convId, reschedulingApptId: oldApptId },
      data: { reschedulingApptId: null },
    });
    if (cleared.count === 1) {
      await prisma.staffNotice.create({
        data: {
          clinicId,
          conversationId: convId,
          kind: "HANDOFF_REQUEST",
          title: "病人經 Flow 改期 — 請入 Apricot 新單並處理舊單",
          meta: { oldApptId, holdId } as object,
        },
      });
      log.warn({ convId, oldApptId, holdId }, "flow endpoint: claim 喺改期 context — 旗標已清 + StaffNotice（S5-9：副作用喺 claim 時做）");
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), convId }, "flow endpoint: reschedule context 副作用失敗（best-effort）");
  }
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

export async function POST(req: NextRequest) {
  // ★ S3-6：flows/endpoint per-IP 60/分鐘（外部端點 — 限流防 Meta 重試風暴 / 惡意加密 bomb）
  if (!(await hit(`flow:ip:${clientIpFromHeaders(req.headers)}`, 60, 60))) {
    return err(429, "rate_limited");
  }

  // ★ S3-8：x-hub-signature-256 強制（dev+prod 一致 — mirror webhook fail-closed；
  //   簽名係對 raw body 嘅 HMAC(WA_APP_SECRET) — 先讀 raw text 先可以驗簽再 parse）
  const rawBody = await req.text();
  if (!verifyWaSignature(rawBody, req.headers.get("x-hub-signature-256"), process.env.WA_APP_SECRET)) {
    log.warn("flow endpoint: invalid x-hub-signature-256 → 432");
    return err(432, "invalid_signature");
  }

  let key16: Buffer;
  let reqIvB64: string;
  let plain: DecryptedRequest;
  let envelope: "prod" | "legacy";

  try {
    // 1) 結構檢查 + 信封偵測
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = rawBody ? JSON.parse(rawBody) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
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
        return err(421, "decrypt_failed");
      }
      reqIvB64 = body.initial_vector;
    } else if (phoneId && waId && enc?.payload && enc.iv && enc.key_id && enc.wrapped_key) {
      // ── legacy 信封（mock client / 舊 canvas） ──
      envelope = "legacy";
      // S3-8：production + 非 mock → legacy 信封 outright 拒（生產 Meta 只會用真 spec 信封；
      // dev/e2e（WA_MOCK=1 或 NODE_ENV≠production）照舊放行）
      if (process.env.NODE_ENV === "production" && process.env.WA_MOCK !== "1") {
        log.warn({ phone: phoneId }, "flow endpoint: legacy envelope in production → 400");
        return err(400, "legacy_envelope_not_allowed");
      }
      const kp = ensureKeypair();
      if (enc.key_id !== kp.kid) {
        log.warn({ phone: phoneId }, "flow endpoint: unknown key_id");
        return err(421, "decrypt_failed");
      }
      try {
        key16 = unwrapAesKey(kp.privatePem, enc.wrapped_key);
        plain = JSON.parse(decryptGcm(key16, enc.iv, enc.payload)) as DecryptedRequest;
      } catch {
        log.warn({ phone: phoneId }, "flow endpoint: decrypt failed (legacy)");
        return err(421, "decrypt_failed");
      }
      reqIvB64 = enc.iv;
    } else {
      return err(400, "bad_request_shape");
    }

    const action = plain.action;
    if (!action) return err(400, "bad_action");

    // ★ S3-6：per flow_token 30/分鐘（防同 token 重放風暴 — 解密後先知 token）
    if (plain.flow_token && !(await hit(`flow:token:${plain.flow_token}`, 30, 60))) {
      return err(429, "rate_limited");
    }

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
      return err(427, "invalid_flow_token");
    }

    // 3) FlowSession 對照（token 必須對應一個 SENT / COMPLETED session）
    //    ★ S5-9 fix（T101 replay / T98 legacy 迴歸）：session 喺 claim 時已 COMPLETED —
    //    Meta 重複 submit_confirm 重試（冪等 replay）+ legacy canvas 三 action 照同一 token，都要入得嚟；
    //    COMPLETED 放行，但 submit_confirm 分支只准「active hold replay」，唔准再 claim（防舊 token 雙約）。
    const session = await prisma.flowSession.findUnique({ where: { flowToken: plain.flow_token! } });
    const sessionUsable = !!session && (session.status === "SENT" || session.status === "COMPLETED");
    if (!sessionUsable || session!.conversationId !== tokenPayload.convId || session!.clinicId !== tokenPayload.clinicId) {
      log.warn({ convId: tokenPayload.convId, status: session?.status ?? null }, "flow endpoint: flow_token 無對應 SENT/COMPLETED session");
      return err(427, "invalid_flow_token");
    }

    // 4) 對話 / 店 對照
    const conv = await prisma.conversation.findUnique({ where: { id: tokenPayload.convId } });
    if (!conv || conv.clinicId !== tokenPayload.clinicId) return err(427, "invalid_flow_token");
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

      // ★ cwi-final S5-14④（P2「Endpoint 10 秒預算」）：總 deadline 8 秒（留 2 秒響應序列化 + 網絡）；
      //   剩 < 3 秒唔開背景 refresh（用現有數據）— 背景刷新唔准吃病人 flow 預算。
      const deadlineAt = Date.now() + 8_000;
      const budgetLeftMs = () => deadlineAt - Date.now();

      // T4：三屏全行 workforce bookable-slots（單一來源 — slotKey 不透明 server 簽發；
      // MD §2：inbox 唔自行計算可約時段）。降級：API fail → bookableDays=null → 日期屏 error
      const dateMin = hkTodayStr();
      const dateMax = hkDateOffset(30);

      // ★ cwi-refresh-20260831 §5：Flow 出 options 前，若 L2 >20m 新鮮度過期 → 先靜默行一次
      //   refresh+bust 先出 options（單日窗口限制病人側延遲；fail-soft — 失敗照用現有數據）。
      //   focus：submit_date = 病人揀緊嘅日；INIT/BACK = 今日（focus 日 — 避免 30 日全刷阻塞病人 flow）。
      let focusDate: string | null = null;
      if (action === "data_exchange") {
        const dd = plain.data ?? {};
        if (dd.user_action === "submit_date") {
          const dt = String(dd.date ?? "");
          if (!dateRangeError(dt)) focusDate = dt;
        }
      } else if (action === "INIT" || action === "BACK") {
        focusDate = dateMin;
      }
      if (focusDate) {
        // ★ S5-14③（P2「空檔新鮮度」）：per-day MIN(syncedAt)；某日冇 row = unknown（當 stale）。
        //   舊 window MAX 會瞞住「窗口有新同步但 focus 日 stale/冇 row」。
        const freshness = await getSlotDayFreshness(clinicId, focusDate);
        const ageMs = freshness.syncedAt ? Date.now() - freshness.syncedAt.getTime() : Number.POSITIVE_INFINITY;
        if (ageMs > 20 * 60_000 || freshness.stale) {
          // ★ S5-14④：剩 < 3 秒 → 跳過背景 refresh（用現有數據）
          if (budgetLeftMs() < 3_000) {
            log.info({ clinic: clinic.code, focusDate, budgetLeftMs: budgetLeftMs() }, "flow endpoint: budget <3s → skip silent pre-refresh（照用現有數據）");
          } else {
            try {
              const r = await refreshAvailability(clinic.code, [focusDate]);
              for (const day of r.refreshed) if (day.ok) await invalidateAvailabilityDay(clinic.code, day.date);
              log.info({ clinic: clinic.code, focusDate, okDays: r.refreshed.filter((x) => x.ok).length, budgetLeftMs: budgetLeftMs() }, "flow endpoint: silent pre-refresh done（L2 >20m stale）");
            } catch (e) {
              log.warn({ clinic: clinic.code, focusDate, err: e instanceof Error ? e.name : "?" }, "flow endpoint: silent pre-refresh fail（fail-soft — 照用現有數據）");
            }
          }
        }
      }

      let bookableDays: BookableDay[] | null = null;
      try {
        // G-4（cwi-capacity-20260904 B7，F2）：候選 filter — remainingCapacity ≤ 0（滿格）唔出；
        // 缺欄當 1（老 F 向後兼容）。checkClash 照舊係 confirm 前最終防線（兩層唔合併）。
        bookableDays = (await getBookableSlots(clinic.code, dateMin, dateMax)).days.map((day) => {
          const slots = filterBookableSlots(day.slots);
          return { ...day, slots, offerableCount: slots.length };
        });
      } catch (e) {
        log.warn({ clinic: clinic.code, err: e instanceof Error ? e.name : "?" }, "flow endpoint: bookable-slots fail → 降級 NONE");
      }
      const sysDownMsg = "預約系統暫時唔到，請稍後再試";

      // INIT（開 Flow）→ 日期屏（DatePicker min=今日 max=+30；dates[] = 可約日，e2e/兼容）
      if (action === "INIT") {
        log.info({ clinic: clinic.code, degraded: bookableDays === null ? "NONE" : null, convId: conv.id }, "flow endpoint: INIT → SCR_DATE");
        return prodResp(key16, reqIvB64, SCREEN_DATE, bookableDateScreenData(bookableDays, dateMin, dateMax, bookableDays === null ? sysDownMsg : undefined));
      }

      // BACK（refresh_on_back=false → 正常唔會到；到咗就穩陣返日期屏重算）
      if (action === "BACK") {
        log.info({ clinic: clinic.code, screen: plain.screen, convId: conv.id }, "flow endpoint: BACK → SCR_DATE");
        return prodResp(key16, reqIvB64, SCREEN_DATE, bookableDateScreenData(bookableDays, dateMin, dateMax, bookableDays === null ? sysDownMsg : undefined));
      }

      // data_exchange — 由 data.user_action 分支（屏級意圖；唔用 "action" 名 — Meta 會 collision）
      const d = plain.data ?? {};
      const userAction = typeof d.user_action === "string" ? d.user_action : "";
      if (!userAction) return err(400, "bad_user_action");

      // ── submit_date：日期 → 醫生/時段 options（bookable 源）──
      if (userAction === "submit_date") {
        const date = String(d.date ?? "");
        const rangeErr = dateRangeError(date);
        if (rangeErr || bookableDays === null) {
          const msg = bookableDays === null ? sysDownMsg : (rangeErr ?? "日期有誤，請重揀");
          log.info({ clinic: clinic.code, date, error: msg, convId: conv.id }, "flow endpoint: submit_date → stay SCR_DATE");
          return prodResp(key16, reqIvB64, SCREEN_DATE, bookableDateScreenData(bookableDays, dateMin, dateMax, msg));
        }
        const day = bookableDays.find((x) => x.date === date);
        if (!day || day.closed || day.slots.length === 0) {
          log.info({ clinic: clinic.code, date, convId: conv.id }, "flow endpoint: submit_date → 該日無空檔");
          return prodResp(key16, reqIvB64, SCREEN_DATE, bookableDateScreenData(bookableDays, dateMin, dateMax, "呢日冇空檔，請揀其他日期"));
        }
        // ★ S5-14①：「醫生 · 時段」組合 list，每頁 20 + has_more（「更多」= canvas 重送 submit_date + page:N+1）
        const page = Math.max(1, Math.floor(Number(d.page ?? 1)) || 1);
        const slotData = bookableSlotData(date, day.slots, page);
        log.info({ clinic: clinic.code, date, page, options: slotData.options.length, has_more: slotData.has_more, convId: conv.id }, "flow endpoint: submit_date → SCR_SLOT");
        return prodResp(key16, reqIvB64, SCREEN_SLOT, slotData);
      }

      // ── submit_slot：醫生+時段 組合驗證（bookable 源）→ 確認屏 ──
      if (userAction === "submit_slot") {
        const date = String(d.date ?? "");
        let providerId = String(d.provider_id ?? "");
        let time = String(d.time ?? "");
        // ★ S5-14①：組合 list 變體 — canvas 選中 option.id = `${providerId}|${start}` 原樣回傳 `selected`
        const selected = typeof d.selected === "string" ? d.selected : "";
        if ((!providerId || !time) && selected) {
          const [p, t] = selected.split("|");
          if (!providerId && p) providerId = p;
          if (!time && t) time = t;
        }
        const day = bookableDays !== null ? bookableDays.find((x) => x.date === date) : undefined;
        const slot = day?.slots.find((s) => s.providerId === providerId && s.start === time);
        if (dateRangeError(date) || bookableDays === null || !slot) {
          const msg = bookableDays === null ? sysDownMsg : "資料有誤，請返回重揀";
          log.info({ clinic: clinic.code, date, providerId, error: msg, convId: conv.id }, "flow endpoint: submit_slot → error");
          return bookableSlotErrorResp(key16, reqIvB64, date, bookableDays, dateMin, dateMax, msg);
        }
        log.info({ clinic: clinic.code, date, providerId, time, convId: conv.id }, "flow endpoint: submit_slot → SCR_CONFIRM");
        return prodResp(key16, reqIvB64, SCREEN_CONFIRM, confirmScreenData({ date, providerId, providerName: slot.providerName, time, profileName }));
      }

      // ── submit_confirm：★ claim 時機（MD §3.2/§5.2）— 病人資料齊先佔位 → FlowHoldEvent → SUCCESS ──
      //     冪等：claimSlot 內部由 flow_token 派生同一 claimToken（Meta 重試同 token 同 slot → 同 hold 唔雙佔）
      if (userAction === "submit_confirm") {
        const date = String(d.date ?? "");
        const providerId = String(d.provider_id ?? "");
        const time = String(d.time ?? "");
        const name = String(d.name ?? "").trim();
        const patientPhoneInput = String(d.patient_phone ?? "").trim();
        const notes = String(d.notes ?? "").slice(0, 200);
        // patient_phone 空 = 病人自己 WhatsApp 號碼（現有 booking 慣例）
        const patientPhone = patientPhoneInput || contact?.waId || "";
        // ★ Flow 級冪等（T4）：呢個 token 已 claim 過 → 直接重放 SUCCESS。
        //   （自己個 hold 會計入 capacity → claim 後該 slot 會離開 bookable；冇呢步 replay 會被誤判「slot 冇咗」重導 SCR_SLOT，病人已約成功卻被要求重揀）
        //   ★ cwi-final S5-14⑤（P2「COMMITTED 被降級」）：replay 條件由「HELD|IN_APRICOT」改為「非 RELEASED/EXPIRED」—
        //   COMMITTED 被 workforce 降級返 HELD（rollback 重寫）/ 或者仍然 COMMITTED，都係 active → 照重放 SUCCESS（唔好叫病人重揀）。
        const existingHold = await prisma.flowHoldEvent.findUnique({ where: { flowToken: plain.flow_token! } });
        if (existingHold && existingHold.status !== "RELEASED" && existingHold.status !== "EXPIRED") {
          log.info({ clinic: clinic.code, date, providerId, time, holdId: existingHold.workforceHoldId, convId: conv.id }, "flow endpoint: submit_confirm → 冪等 replay（FlowHoldEvent active）");
          // ★ S5-9：replay 都標 COMPLETED（session 可能仲 SENT — endpoint 先標後 crash / 舊行）
          await completeFlowSession(session.id, conv.id, existingHold.workforceHoldId, "replay");
          return prodSuccess(key16, reqIvB64, {
            flow_token: plain.flow_token,
            providerId: existingHold.providerId,
            providerName: existingHold.providerName,
            date: existingHold.date,
            time: minToHhmm(existingHold.startMin),
            name: name || existingHold.patientName || "",
            notes,
            holdId: existingHold.workforceHoldId,
          });
        }
        // ★ S5-9：session 已 COMPLETED 但冇 active hold（舊 token / flow 已由其他路徑完成）→ 拒，唔准再 claim
        if (session.status !== "SENT") {
          log.warn({ convId: conv.id, sessionStatus: session.status }, "flow endpoint: submit_confirm on COMPLETED session 冇 active hold — 舊 token 拒");
          return err(427, "invalid_flow_token");
        }
        if (!name || name.length > 40 || patientPhone.length < 5 || patientPhone.length > 20 || !TIME_RE.test(time)) {
          log.info({ clinic: clinic.code, date, providerId, nameLen: name.length, error: "bad_payload", convId: conv.id }, "flow endpoint: submit_confirm → bad payload");
          return confirmErrorRespBookable(key16, reqIvB64, bookableDays, date, providerId, time, profileName, "資料有誤，請返回重揀");
        }
        if (bookableDays === null) {
          log.warn({ clinic: clinic.code, date, providerId, time, convId: conv.id }, "flow endpoint: submit_confirm → 系統唔到");
          return confirmErrorRespBookable(key16, reqIvB64, bookableDays, date, providerId, time, profileName, sysDownMsg);
        }
        const day = bookableDays.find((x) => x.date === date);
        const slot = day?.slots.find((s) => s.providerId === providerId && s.start === time);
        if (!slot) {
          // slot 已冇（中途被人佔走）→ 409 等價 → 重拉最新列表重導 SCR_SLOT
          log.info({ clinic: clinic.code, date, providerId, time, convId: conv.id }, "flow endpoint: submit_confirm → slot missing → SCR_SLOT 重導");
          return bookableSlotErrorResp(key16, reqIvB64, date, await refetchBookableDays(clinic.code, dateMin, dateMax), dateMin, dateMax, "呢個時段啱啱被人預約咗，請揀其他時間");
        }
        if (!slotClaimEnabled()) {
          // ★ cwi-final S0-12（R-4）：Meta Flows 一定要 200 + 加密畫面 — 唔可以回 403
          log.warn({ clinic: clinic.code, convId: conv.id }, "flow endpoint: submit_confirm → SLOT_CLAIM_DISABLED");
          return confirmErrorRespBookable(key16, reqIvB64, bookableDays, date, providerId, time, profileName,
            "網上預約暫停中，請直接喺 WhatsApp 話我哋想約嘅時間，同事會幫你安排🙏");
        }
        let claim;
        try {
          claim = await claimSlot({ slotKey: slot.slotKey, patientWaId: patientPhone, patientName: name, flowToken: plain.flow_token! });
        } catch (e) {
          if (e instanceof WorkforceApiError && e.status === 409) {
            if (e.code === "FLOW_TOKEN_REUSED") {
              log.warn({ clinic: clinic.code, convId: conv.id }, "flow endpoint: submit_confirm → 409 flow_token_reused");
              return confirmErrorRespBookable(key16, reqIvB64, bookableDays, date, providerId, time, profileName, "呢單預約已經確認過，請勿重複提交");
            }
            // 輸咗 race → 重拉最新列表重導（全列表比 409 body 嘅 alternatives 完整）。
            // 注意：真 T1 slot_taken 409 body = { v:1, error:"slot_taken", alternatives } — 無 code 欄
            // （contract 實錘 2026-08-31 CEO 核）→ 409 分支唔靠 code，除 FLOW_TOKEN_REUSED 外一律當 slot_taken
            log.info({ clinic: clinic.code, date, providerId, time, code: e.code ?? "slot_taken", convId: conv.id }, "flow endpoint: submit_confirm → 409 slot_taken → SCR_SLOT 重導");
            return bookableSlotErrorResp(key16, reqIvB64, date, await refetchBookableDays(clinic.code, dateMin, dateMax), dateMin, dateMax, "呢個時段啱啱被人預約咗，請揀其他時間");
          }
          log.warn({ clinic: clinic.code, date, providerId, time, err: e instanceof Error ? e.name : "?", convId: conv.id }, "flow endpoint: submit_confirm → claim fail");
          return confirmErrorRespBookable(key16, reqIvB64, bookableDays, date, providerId, time, profileName, "預約系統出錯，請重試");
        }
        // claim 201 → FlowHoldEvent（T3 表 — 預約卡「線上已佔·等你入 Apricot」；flowToken 冪等 upsert）
        const startMin = hhmmToMin(time);
        let holdRow;
        try {
          holdRow = await prisma.flowHoldEvent.upsert({
            where: { flowToken: plain.flow_token! },
            create: {
              flowToken: plain.flow_token!,
              workforceHoldId: claim.holdId,
              clinicCode: clinic.code,
              clinicId,
              providerName: claim.providerName,
              providerId,
              date,
              startMin,
              endMin: startMin + 30,
              status: "HELD",
              patientName: name,
              patientPhone,
              // ★ cwi-final S5-11（F4）：病人喺 Flow 打嘅電話（同 patientPhone = WA 號 fallback 分清；卡顯示「病人留嘅電話」）
              contactPhone: patientPhoneInput || null,
              notes: notes || null,
              // ★ cwi-final S5-8②（F2）：改期 context 由 FlowSession 帶入
              //   （hold 卡紅標 + commit 成功後 102 舊單；conversationId 俾 S5-11（F4）sweep 用）
              rescheduleOfApptId: session.rescheduleOfApptId ?? null,
              conversationId: conv.id,
              source: "whatsapp_flow",
            },
            update: {
              // 冪等重放（Meta 重試）：唔覆病人資料，只對齊 holdId + 改期 context。
              // ★ S5-14⑤：update **唔寫 status** — 舊行可能已 IN_APRICOT/COMMITTED（已寫 Apricot），
              //   重放唔好降級返 HELD（降級會令 commit sweep / 卡狀態錯亂）。
              workforceHoldId: claim.holdId,
              rescheduleOfApptId: session.rescheduleOfApptId ?? null,
              conversationId: conv.id,
            },
          });
        } catch (e) {
          // ★ S5-14⑤：P2002（flowToken unique race — 並發請求同時 create）→ 對返已有 row 當 replay
          if ((e as { code?: string })?.code !== "P2002") throw e;
          const raced = await prisma.flowHoldEvent.findUnique({ where: { flowToken: plain.flow_token! } });
          if (raced && raced.status !== "RELEASED" && raced.status !== "EXPIRED") {
            log.info({ clinic: clinic.code, convId: conv.id, status: raced.status }, "flow endpoint: upsert P2002 → replay（已有 hold）");
            return prodSuccess(key16, reqIvB64, {
              flow_token: plain.flow_token,
              providerId: raced.providerId ?? providerId,
              providerName: raced.providerName,
              date: raced.date,
              time: minToHhmm(raced.startMin),
              name: name || raced.patientName || "",
              notes,
              holdId: raced.workforceHoldId,
            });
          }
          throw e; // RELEASED/EXPIRED（應該已被上面 replay 擋）— 唔預期 → 500 兜底
        }
        // ★ cwi-final S5-11（F4）：claim 成功 → 實時 push（client 補載 hold 卡）— commit-then-emit；
        //   fail-soft（推播失敗唔阻 patient response；REST refresh 兜底）；payload 零病人 PII
        try {
          await publishConvEvent(convRef(conv), "hold:new", {
            holdEventId: holdRow.id,
            conversationId: conv.id,
            clinicCode: clinic.code,
            providerName: claim.providerName,
            date,
            startMin,
            endMin: startMin + 30,
            status: "HELD",
          });
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err), convId: conv.id }, "flow endpoint: hold:new push 失敗（REST refresh 兜底）");
        }
        // ★ cwi-final S5-9：claim 成功即 COMPLETED（唔依賴 nfm_reply）+ 改期 context 副作用（旗標+notice 喺 claim 時）
        if (session.rescheduleOfApptId) {
          await applyRescheduleContext(conv.id, clinic.id, session.rescheduleOfApptId, claim.holdId);
        }
        await completeFlowSession(session.id, conv.id, claim.holdId, "claim");
        await prisma.auditLog
          .create({
            data: {
              staffId: null,
              action: "FLOW_CLAIM",
              entity: "FlowHoldEvent",
              entityId: claim.holdId,
              meta: { clinicCode: clinic.code, date, time, providerId } as object,
            },
          })
          .catch(() => undefined);
        log.info({ clinic: clinic.code, date, providerId, time, nameLen: name.length, convId: conv.id, holdId: claim.holdId }, "flow endpoint: submit_confirm → claim 201 → SUCCESS");
        return prodSuccess(key16, reqIvB64, {
          flow_token: plain.flow_token,
          providerId,
          providerName: claim.providerName,
          date,
          time,
          name,
          notes,
          holdId: claim.holdId, // T4 claimed 標記 — flow-reply 認自描述 params（唔行 L2 precheck / 唔建 BookingRequest）
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

// ── 新 spec bookable helpers（T4 — SCR_SLOT options = bookable 該日 slots）─────────────

/** 由該日 bookable slots 砌 SCR_SLOT data（★ S5-14①：「醫生 · 時段」組合 list，每頁 20 + has_more；
 *  舊 providers/times 去重 list 保留作向下兼容；slotKey 唔出屏 — 提交時 server 重查全量）。 */
function bookableSlotData(date: string, slots: BookableSlot[], page = 1) {
  return slotScreenDataPaged({ date, slots, page });
}

/** SCR_DATE data（bookable 源）：date picker min/max + 可約日 + error（v2 同送規則）。 */
function bookableDateScreenData(days: BookableDay[] | null, dateMin: string, dateMax: string, error?: string) {
  const openDates = days
    ? [...new Set(days.filter((dy) => !dy.closed && dy.slots.length > 0).map((dy) => dy.date))].sort()
    : [];
  return bookableDateScreen({ dateMin, dateMax, openDates, error });
}

/** 409/資料有誤：用最新 bookable 重導 SCR_SLOT（該日已冇 slots → 跌返日期屏 + error）。 */
function bookableSlotErrorResp(
  key16: Buffer,
  reqIvB64: string,
  date: string,
  days: BookableDay[] | null,
  dateMin: string,
  dateMax: string,
  msg: string,
): NextResponse {
  const day = !dateRangeError(date) && days !== null ? days.find((x) => x.date === date) : undefined;
  if (day && !day.closed && day.slots.length > 0) {
    return prodResp(key16, reqIvB64, SCREEN_SLOT, {
      ...bookableSlotData(date, day.slots),
      has_error: true,
      error_message: msg,
    });
  }
  return prodResp(key16, reqIvB64, SCREEN_DATE, bookableDateScreenData(days, dateMin, dateMax, msg));
}

/** SCR_CONFIRM 錯誤重渲染（bookable 源 — 醫生名由 bookable slots 查）。 */
function confirmErrorRespBookable(
  key16: Buffer,
  reqIvB64: string,
  days: BookableDay[] | null,
  date: string,
  providerId: string,
  time: string,
  profileName: string,
  msg: string,
): NextResponse {
  const day = days !== null ? days.find((x) => x.date === date) : undefined;
  const slot = day?.slots.find((s) => s.providerId === providerId && s.start === time);
  return prodResp(
    key16,
    reqIvB64,
    SCREEN_CONFIRM,
    confirmScreenData({ date, providerId, providerName: slot?.providerName ?? "（醫生）", time, profileName, error: msg }),
  );
}

/** 409 後重拉最新 bookable（fail-soft → null = 跌日期屏）。 */
async function refetchBookableDays(clinicCode: string, from: string, to: string): Promise<BookableDay[] | null> {
  try {
    return (await getBookableSlots(clinicCode, from, to)).days;
  } catch {
    return null;
  }
}

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
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
