/**
 * clinic-workforce External API client（switch MD §2 — wa-inbox 對 workforce 嘅唯一 HTTP 通道）
 *
 * 契約（兩份一字一樣 — 改契約要兩邊同步）：
 *   GET {WORKFORCE_API_URL}/api/external/v1/availability?clinicCode=&from=&to=[&providerApricotId=]
 *   GET {WORKFORCE_API_URL}/api/external/v1/duty-roster?clinicCode=&date=
 *   Header: x-api-key（gen-external-key 出嗰條）
 *
 * 寫入 + patient-context（booking-ui MD §1 — 2026-08-23）：
 *   POST /api/external/v1/bookings（代落單；冪等 idempotencyKey）
 *   PUT  /api/external/v1/bookings/{id}/status?status=102|-7&date=&clinicCode=
 *   PUT  /api/external/v1/bookings/{id}/remove?date=&clinicCode=
 *   POST /api/external/v1/bookings/{id}/reschedule（原子 102+新單）
 *   GET  /api/external/v1/dictionaries?kind=VISIT_REASON|BOOKING_TYPE（1 小時 memory cache）
 *   GET  /api/external/v1/patient-lookup?phoneHash=
 *   GET  /api/external/v1/appointments?phoneHash=&from=&to=
 *
 * bookable-slots（providerslot-20260830 T1/T3/T4）：
 *   GET  /api/external/v1/bookable-slots?clinicCode=&from=&to=（可約時段；slotKey 不透明簽發）
 *   GET  /api/external/v1/bookable-slots/held?clinicCode=（HELD 清單；零病人 PII）
 *   POST /api/external/v1/bookable-slots/claim（硬保留佔位；Idempotency-Key = claim token）
 *   POST /api/external/v1/bookable-slots/claim/{holdId}/commit（HELD → IN_APRICOT；冪等）
 *
 * zod parse = contract 執行點：response 過唔到 schema = 當 API fail（§3 降級鏈接住）。
 * z.object 預設 strip 唔識欄位 → 病人欄位（medicalHistory 等）物理上入唔到下游。
 *
 * ★ 鐵律：
 * - log 只 path + status（零 body）— WORKFORCE_API_KEY 永遠唔入 log；error 分類 code 只入
 *   WorkforceApiError.code（供路由分支），一樣唔入 log
 * - timeout：讀 3s（WORKFORCE_TIMEOUT_MS 可覆）/ booking-write 90s（WORKFORCE_WRITE_TIMEOUT_MS 可覆）
 * - WORKFORCE_MOCK=1 → mock（§4：fixture 決定性，E2E/開發用）
 *
 * ★ cwi-final S5-1（F1）：booking-write 結果未知（outcome unknown）：
 * - 四條 Apricot booking 寫入（createBooking/updateBookingStatus/removeBooking/rescheduleBooking）
 *   行 `bookingWrite` 分支：write timeout / 網絡錯（status 0）/ 500 / 502(非 MANUAL_RECONCILE)
 *   → throw WorkforceOutcomeUnknown（「可能寫咗可能冇」— 上層唔好扮成功、唔好扮確定失敗）；
 * - 409 IN_PROGRESS / 503 APRICOT_BUSY → 等 WORKFORCE_WRITE_RETRY_DELAY_MS（預設 5s）同 key 重試（≤3）→ 再唔得 UNKNOWN；
 * - 502 MANUAL_RECONCILE / 409 IDEMPOTENCY_* / 409 SLOT_TAKEN / 422 / 503 WRITE_DISABLED / 400 / 403 / 404
 *   = 確定性錯誤 → 原樣 throw WorkforceApiError（唔重試）；
 * - 冪等安全：UNKNOWN 後重試用同一 idempotencyKey（workforce 冪等重放 → 同 apricotApptId）。
 *
 * env：WORKFORCE_API_URL / WORKFORCE_API_KEY / WORKFORCE_MOCK
 *      WORKFORCE_TIMEOUT_MS（預設 3000）/ WORKFORCE_WRITE_TIMEOUT_MS（預設 90000）/
 *      WORKFORCE_WRITE_RETRY_DELAY_MS（預設 5000）
 *      BOOKING_DEFAULT_VISIT_REASON_CODE（預設 visit reason；空 = 無預設，UI/staff 必揀）
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import log from "@/lib/log";
import { invalidateAvailabilityDay } from "@/lib/availability";
import { phoneHashes } from "@/lib/phone-hash";

// ── zod contract（§2 原樣）───────────────────────────────────────────────

const SlotSchema = z.object({
  start: z.string(),
  end: z.string(),
  isOpen: z.boolean(),
  bookedCount: z.number().int(),
  // §D（cwi-r2）：「仲收幾多病人」（併诊規則後）— optional = workforce 未上 capacity 前缺欄照行（fallback=1）
  remainingCapacity: z.number().int().optional(),
});
const ProviderSchema = z.object({ providerApricotId: z.string(), providerName: z.string(), slots: z.array(SlotSchema) });
// ★ export：contract 執行點 — pii-scan contract-strip 層 + scripts/workforce-contract.test.ts 對佢斷言
export const AvailabilityResponse = z.object({
  v: z.literal(1),
  clinicCode: z.string(),
  // ★ 真契約 syncedAt 可為 null（該店零數據 — workforce route 實況：maxSynced=null 時回 null）
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
  days: z.array(z.object({ date: z.string(), providers: z.array(ProviderSchema) })),
});
export type WorkforceAvailability = z.infer<typeof AvailabilityResponse>;

const DutySchema = z.object({ v: z.literal(1), staff: z.array(z.object({
  staffName: z.string(), role: z.string().nullable(), shiftStart: z.string(), shiftEnd: z.string() })) });
export type WorkforceDuty = z.infer<typeof DutySchema>;

// ── 寫入 + patient-context contract（booking-ui MD §1 — 同 clinic-workforce 源碼一字一樣）──
// ★ export：contract 執行點 — scripts/booking-ui-contract.ts 對佢斷言（fixture anchor + parse + PII strip）。

export const BookingCreateResponse = z.object({
  v: z.literal(1),
  apricotApptId: z.string(),
  bookingStatus: z.number().int(),
  patientApricotId: z.string().nullable(),
  patientCode: z.string().nullable(),
  dayRefreshed: z.boolean(),
  syncedAt: z.string().nullable(),
});
export type BookingCreateResult = z.infer<typeof BookingCreateResponse>;

export const BookingStatusResponse = z.object({
  v: z.literal(1),
  bookingStatus: z.number().int(),
  dayRefreshed: z.boolean(),
  syncedAt: z.string().nullable(),
});
export type BookingStatusResult = z.infer<typeof BookingStatusResponse>;

export const BookingRemoveResponse = z.object({
  v: z.literal(1),
  removed: z.literal(true),
  dayRefreshed: z.boolean(),
  syncedAt: z.string().nullable(),
});
export type BookingRemoveResult = z.infer<typeof BookingRemoveResponse>;

export const BookingRescheduleResponse = z.object({
  v: z.literal(1),
  oldApptId: z.string(),
  newApptId: z.string(),
  dayRefreshed: z.boolean(),
  syncedAt: z.string().nullable(),
});
export type BookingRescheduleResult = z.infer<typeof BookingRescheduleResponse>;

const DictionaryItemSchema = z.object({ apricotId: z.string(), code: z.string(), des: z.string() });
export const DictionariesResponse = z.object({
  v: z.literal(1),
  kind: z.enum(["VISIT_REASON", "BOOKING_TYPE"]),
  items: z.array(DictionaryItemSchema),
});
export type DictionariesResult = z.infer<typeof DictionariesResponse>;

/** ★ cwi-followup-p0-20260915（MD §1.1）：公司主資料快取來源（workforce GET /companies，scope org）。
 *  形狀對齊 workforce contract fixture test/fixtures/external-v1-companies.json（sha256 錨定）。
 *  只回機構代碼表（id/name/code）— 零病人資料、零電話。 */
const CompanyClinicSchema = z.object({ id: z.string(), code: z.string(), name: z.string() });
export const CompaniesResponse = z.object({
  v: z.literal(1),
  companies: z.array(
    z.object({
      companyApricotId: z.string().optional(), // CWM Company 表而家無 apricot id 欄 → 唔回
      id: z.string(), // = workforce Company.id（wa-inbox sourceId）
      name: z.string(),
      clinics: z.array(CompanyClinicSchema),
    })
  ),
});
export type CompaniesResult = z.infer<typeof CompaniesResponse>;

/** ★ cwi-final S5-13②：lastVisit 加 clinicId/clinicCode（「最近到診：{店}」）；
 *  match 加 visitedClinicIds（全行 distinct clinicId — 跨公司黃標判斷）；gender「有就回」（B-9，PII 白名單未加欄前永遠無）。 */
const LastVisitSchema = z.object({
  date: z.string(),
  providerName: z.string(),
  visitReasons: z.array(z.string()),
  clinicId: z.string().optional(),
  clinicCode: z.string().optional(),
});
export const PatientLookupResponse = z.object({
  v: z.literal(1),
  matches: z.array(z.object({
    patientApricotId: z.string(),
    patientCode: z.string(),
    patientName: z.string(),
    lastVisit: LastVisitSchema.nullable(),
    visitedClinicIds: z.array(z.string()).optional(),
    gender: z.string().optional(),
  })),
});
export type PatientLookupResult = z.infer<typeof PatientLookupResponse>;

export const AppointmentsResponse = z.object({
  v: z.literal(1),
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
  appointments: z.array(z.object({
    apricotApptId: z.string(),
    clinicCode: z.string(),
    providerApricotId: z.string(),
    providerName: z.string(),
    date: z.string(),
    start: z.string(),
    end: z.string(),
    bookingStatus: z.number().int(),
    patientApricotId: z.string(),
    patientCode: z.string(),
    patientName: z.string(),
    visitReasons: z.array(z.string()),
    remarks: z.string().nullable(),
  })),
});
export type WorkforceAppointment = z.infer<typeof AppointmentsResponse>["appointments"][number];
export type AppointmentsResult = z.infer<typeof AppointmentsResponse>;

// ── P2 病人記錄 contract（followup-v2 MD §2.6 #3/#4/#5/#6/#8 — 對齊 CWM dev stub）──
// ★ export：contract 執行點 — zod strip 唔識欄位（臨床全文只可經 #5 note 欄入下游）。

const RxCodeSchema = z.object({
  code: z.string(),
  name: z.string(),
  isAntibiotic: z.boolean(), // cwi-followup-p4 S4：C 類抗生素判定
});

const VisitRowSchema = z.object({
  visitId: z.string(),
  visitDate: z.string(), // YYYY-MM-DD（HK 日界）
  clinicCode: z.string(),
  bookingStatus: z.number().int(),
  visitReasonCodes: z.array(z.string()),
  providerCode: z.string().nullable(),
  hasNote: z.boolean(),
  rxCodes: z.array(RxCodeSchema), // cwi-followup-p4 S4（零全文 — code+name+抗生素旗）
  noteKind: z.enum(["STANDARD", "TEMPLATE"]).nullable(),
  firstLine: z.string().max(60).nullable(), // ≤60 字（MD §2.4 邊界）
});
export const PatientVisitsResponse = z.object({
  v: z.literal(1),
  patientCode: z.string(),
  visits: z.array(VisitRowSchema),
});
export type PatientVisit = z.infer<typeof VisitRowSchema>;
export type PatientVisitsResult = z.infer<typeof PatientVisitsResponse>;

// ── cwi-followup-p4（S3/S4/S5）：batch #1 visits + 報價 + 術語表 ──────────
export const BatchVisitsResponse = z.object({
  v: z.literal(1),
  visits: z.array(
    z.object({
      visitId: z.string(),
      patientApricotId: z.string(),
      patientCode: z.string(),
      phoneHashes: z.array(z.string()), // 只 hash（零原始電話）
      visitDate: z.string(),
      clinicCode: z.string(),
      bookingStatus: z.number().int(),
      visitReasonCodes: z.array(z.string()),
      providerCode: z.string().nullable(),
      hasNote: z.boolean(),
      quotedItems: z.unknown().nullable(),
      rxCodes: z.array(RxCodeSchema),
      billTtlAmt: z.number().int().nullable(),
      billOsAmt: z.number().int().nullable(),
    })
  ),
});
export type BatchVisit = z.infer<typeof BatchVisitsResponse>["visits"][number];
export type BatchVisitsResult = z.infer<typeof BatchVisitsResponse>;

export const QuoteSchema = z.object({
  id: z.string(),
  patientApricotId: z.string(),
  clinicCode: z.string(),
  sourceVisitDate: z.string(),
  text: z.string(),
  termShorthand: z.string().nullable(),
  nameCn: z.string().nullable(),
  amountMin: z.number().int().nullable(),
  amountMax: z.number().int().nullable(),
  perUnit: z.boolean(),
  fdiTeeth: z.array(z.string()),
  intent: z.enum(["not_done", "unknown"]),
  certainty: z.enum(["high", "low"]),
  source: z.enum(["parser", "llm", "manual"]),
  status: z.enum(["pending", "confirmed", "corrected", "discarded"]),
});
export const QuotesResponse = z.object({ v: z.literal(1), quotes: z.array(QuoteSchema) });
export type WorkforceQuote = z.infer<typeof QuoteSchema>;
export type QuotesResult = z.infer<typeof QuotesResponse>;
export const QuoteDecisionResponse = z.object({
  v: z.literal(1),
  id: z.string(),
  status: z.enum(["confirmed", "corrected", "discarded"]),
  termMapUpserted: z.boolean(),
});
export type QuoteDecisionResult = z.infer<typeof QuoteDecisionResponse>;

export const TermEntrySchema = z.object({
  id: z.string(),
  shorthand: z.string(),
  nameCn: z.string(),
  nameEn: z.string().nullable(),
  usedFor: z.array(z.string()),
  active: z.boolean(),
  updatedAt: z.string(),
});
export const TermMapResponse = z.object({ v: z.literal(1), terms: z.array(TermEntrySchema) });
export type WorkforceTerm = z.infer<typeof TermEntrySchema>;
export type TermMapResult = z.infer<typeof TermMapResponse>;

/** 兩種樣板（MD §0.3 — 對齊 CWM NoteText）：STANDARD 四段 / TEMPLATE blocks（Tx 原文保留換行）。 */
const NoteStandardSchema = z.object({
  kind: z.literal("STANDARD"),
  complaints: z.string(),
  findings: z.string(),
  diagnosis: z.string(),
  actions: z.string(),
});
const NoteTemplateSchema = z.object({
  kind: z.literal("TEMPLATE"),
  templateName: z.string().nullable(),
  blocks: z.array(z.object({ label: z.string(), text: z.string() })),
});
export type NoteText = z.infer<typeof NoteStandardSchema> | z.infer<typeof NoteTemplateSchema>;
export const VisitNoteResponse = z.object({
  v: z.literal(1),
  visitId: z.string(),
  patientApricotId: z.string(),
  visitDate: z.string(),
  noteKind: z.string(),
  note: z.discriminatedUnion("kind", [NoteStandardSchema, NoteTemplateSchema]),
});
export type VisitNoteResult = z.infer<typeof VisitNoteResponse>;

export const PatientBalanceResponse = z.object({
  v: z.literal(1),
  patientCode: z.string(),
  asOf: z.string(),
  balance: z.object({ ttlAmt: z.number().int().nullable(), osAmt: z.number().int().nullable() }),
  syncedAt: z.string(),
});
export type PatientBalanceResult = z.infer<typeof PatientBalanceResponse>;

/** #3 clinic 模式（MD §2.6 #3 — B 類 + P2 配對）：appointment 行多 phoneHashes[]（永不回原始電話）。 */
export const ClinicAppointmentsResponse = z.object({
  v: z.literal(1),
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
  appointments: z.array(
    z.object({
      apricotApptId: z.string(),
      clinicCode: z.string(),
      providerApricotId: z.string(),
      providerName: z.string(),
      date: z.string(),
      start: z.string(),
      end: z.string(),
      bookingStatus: z.number().int(),
      patientApricotId: z.string(),
      patientCode: z.string(),
      patientName: z.string(),
      visitReasons: z.array(z.string()),
      remarks: z.string().nullable(),
      phoneHashes: z.array(z.string()).optional(),
    })
  ),
});
export type ClinicAppointment = z.infer<typeof ClinicAppointmentsResponse>["appointments"][number];
export type ClinicAppointmentsResult = z.infer<typeof ClinicAppointmentsResponse>;

/** #8 手動刷新（MD §2.8）：200 成功。429 RATE_LIMITED（retryAfterSec）/ 503 APRICOT_UNAVAILABLE — 唔扮成功。 */
export const PatientRefreshResponse = z.object({
  v: z.literal(1),
  syncedAt: z.string(),
  visits: z.number().int(),
  balance: z.object({ ttlAmt: z.number().int().nullable(), osAmt: z.number().int().nullable() }),
});
export type PatientRefreshResult = z.infer<typeof PatientRefreshResponse>;

// ── bookable-slots（providerslot-20260830 T1 contract — MD 3.1/3.3 原樣）──────
// ★ 只出 offerable 格（非 offerable 唔入 payload — 滿/lead-time/未開診前台無法再分）；
//   零 PII（slots 只有時間/醫生/位數）；碎片唔入 payload（MD 3.1 註）。
const BookableSlotSchema = z.object({
  start: z.string(),
  end: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  seatsFree: z.number().int().min(0),
  /** G-4（cwi-capacity-20260904 B7，F2）：每醫生每時段剩餘 = capacity − booked
   *  （問診+覆診共享池）；optional = 老 F 未上欄 → 缺欄當 1（向後兼容） */
  remainingCapacity: z.number().int().min(0).optional(),
  slotKey: z.string(),
});
export const BookableSlotsResponse = z.object({
  v: z.literal(1),
  unitMin: z.literal(30),
  capacityPerProvider: z.number().int().positive(),
  leadTimeMin: z.number().int().min(0),
  generatedAt: z.string(),
  days: z.array(
    z.object({
      date: z.string(),
      closed: z.boolean(),
      offerableCount: z.number().int().min(0),
      slots: z.array(BookableSlotSchema),
    })
  ),
});
export type BookableSlot = z.infer<typeof BookableSlotSchema>;
export type BookableDay = BookableSlotsResult["days"][number];
export type BookableSlotsResult = z.infer<typeof BookableSlotsResponse>;

// ── G-4（cwi-capacity-20260904 B7，F2）：capacity 候選過濾 ────────────────────
// F2 疊診規則：每醫生每時段最多 3 人，問診（新）+ 覆診（舊）共享同一池。
// remainingCapacity = capacity − booked（F 側已計）；缺欄 → 當 1（老 F / 未上欄向後兼容）。
// 鐵律：capacity 係候選過濾層；checkClash（confirm 前）係最終防線 — 兩層唔合併。
export function slotRemainingCapacity(s: Pick<BookableSlot, "remainingCapacity">): number {
  return typeof s.remainingCapacity === "number" ? s.remainingCapacity : 1;
}

/** 候選 filter：remainingCapacity ≤ 0 = 滿格 → 唔出（防禦層 — 現行 F/mock 只出 offerable，實上恒過）。 */
export function filterBookableSlots<T extends Pick<BookableSlot, "remainingCapacity">>(slots: T[]): T[] {
  return slots.filter((s) => slotRemainingCapacity(s) > 0);
}

// held PII-free 讀（T3 警報用 — MD 交貨 #7）：零病人資料；holdTimeoutHours = clinic 設定
//（response 層帶出，12h MEDIUM / 24h HIGH 唔硬編）。
export const HeldResponse = z.object({
  v: z.literal(1),
  generatedAt: z.string(),
  holdTimeoutHours: z.number().int().positive().nullable(),
  holds: z.array(
    z.object({
      holdId: z.string(),
      date: z.string(),
      startMin: z.number().int().min(0),
      endMin: z.number().int().min(0),
      providerId: z.string(),
      providerName: z.string(),
      status: z.enum(["HELD", "IN_APRICOT"]),
      source: z.string(),
      createdAt: z.string(),
      ageHours: z.number().min(0),
      appointmentPast: z.boolean(),
    })
  ),
});
export type HeldItem = z.infer<typeof HeldResponse>["holds"][number];
export type HeldResult = z.infer<typeof HeldResponse>;

// commit（MD 3.3）— 前台已入 Apricot：HELD → IN_APRICOT（冪等；RELEASED → 409）。
const HoldCommitResponse = z.object({
  v: z.literal(1),
  holdId: z.string(),
  status: z.literal("IN_APRICOT"),
  committedAt: z.string().nullable(),
});
export type HoldCommitResult = z.infer<typeof HoldCommitResponse>;

// release（MD 3.3）— 病人取消／前台放開：HELD → RELEASED（冪等；已 RELEASED → 200 同狀；hold 唔存在 → 404）
const HoldReleaseResponse = z.object({
  v: z.literal(1),
  holdId: z.string(),
  status: z.literal("RELEASED"),
  apricotRef: z.string().nullable(),
});
export type HoldReleaseResult = z.infer<typeof HoldReleaseResponse>;

// claim（MD 3.2 / providerslot T4）— 佔位硬保留：workforce 單交易重算 offerable → 插 hold。
// 🔴 response 零病人回顯（只時段/醫生欄）；409 → WorkforceApiError(code=SLOT_TAKEN / FLOW_TOKEN_REUSED)。
export const ClaimResponse = z.object({
  v: z.literal(1),
  holdId: z.string(),
  start: z.string(),
  end: z.string(),
  date: z.string(),
  providerName: z.string(),
  expiresAt: z.string().nullable(),
});
export type ClaimResult = z.infer<typeof ClaimResponse>;

// ── 錯誤類型（log 只 path+status）────────────────────────────────────────

export class WorkforceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    /** workforce 錯誤碼（SLOT_TAKEN / NEW_PATIENT_DISABLED / WRITE_DISABLED / …）— 只供路由分支，唔入 log */
    public readonly code?: string,
    /** cwi-refresh-20260831：429 嘅 retryAfterSec（S1 端點 body 欄；UI 倒數用） */
    public readonly retryAfterSec?: number,
  ) {
    super(`workforce API ${status} ${path}`);
    this.name = "WorkforceApiError";
  }
}

/** ★ cwi-final S0-12：G2 閘（預設關）— 關閉時 claim／commit／發 Flow 都唔出 HTTP */
export function slotClaimEnabled(): boolean {
  return process.env.ALLOW_SLOT_CLAIM === "1";
}
export class SlotClaimDisabledError extends WorkforceApiError {
  constructor(path: string) { super(403, path, "SLOT_CLAIM_DISABLED"); }
}

/**
 * ★ cwi-final S5-1：booking-write 結果未知（outcome unknown）。
 * 語義：「可能寫咗、可能冇寫」— 上層：
 * - 唔可當成功（CONFIRMED 要 workforce 明確 200）；
 * - 唔可盲當失敗（重試用同一 idempotencyKey — workforce 冪等重放安全）；
 * - UI 提示「未確定 — 唔好人手落單，請撳〔重試（同一單號）〕」。
 */
export class WorkforceOutcomeUnknown extends Error {
  constructor(
    public readonly path: string,
    cause?: unknown,
  ) {
    super(`workforce outcome unknown ${path}`);
    this.name = "WorkforceOutcomeUnknown";
    if (cause !== undefined) this.cause = cause;
  }
}

const WORKFORCE_TIMEOUT_MS = Math.max(1, Number(process.env.WORKFORCE_TIMEOUT_MS ?? 3000) || 3000);
// ★ cwi-final S5-1：booking-write 長 timeout（Apricot 寫入可要幾十秒）+ 重試間隔（process start 快照；env 可覆）
const WORKFORCE_WRITE_TIMEOUT_MS = Math.max(1, Number(process.env.WORKFORCE_WRITE_TIMEOUT_MS ?? 90_000) || 90_000);
const WORKFORCE_WRITE_RETRY_DELAY_MS = Math.max(0, Number(process.env.WORKFORCE_WRITE_RETRY_DELAY_MS ?? 5000) || 5000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class WfTimeoutError extends Error {
  constructor(public readonly path: string, public readonly timeoutMs: number) {
    super(`workforce timeout ${timeoutMs}ms ${path}`);
    this.name = "WfTimeoutError";
  }
}

/** Promise.race timeout — 超時 reject WfTimeoutError（底層 promise 繼續跑，零副作用問題：mock store 已先記） */
async function withTimeout<T>(p: Promise<T>, ms: number, path: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new WfTimeoutError(path, ms)), ms);
        t.unref?.();
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

// ── HTTP（real mode）─────────────────────────────────────────────────────

/**
 * real mode fetch：log 只 path + status（零 body）。
 * 4xx/5xx 時只 parse error body 嘅 `code` 欄（分類標籤，供路由分支）— body 本身唔入 log、唔洩傳。
 */
// 🔴 鐵律 7：CWM 外部調用限速 ≥400ms/call（in-process gate；mock 路豁免）。
// ★ cwi-final S5-14④（P2「Endpoint 10 秒預算」）：lastCwmCallAt 時間戳 gate → **promise chain**。
//   舊 timestamp 版：並發 N 支各自算 wait（lastCwmCallAt+400 - now）→ 同刻 burst 第二三支 wait 相近
//   → 實際間隔可能 < 400ms（gate 名存實亡）+ 每支都等自己個 timer（疊加延遲）。
//   chain 版：每支 enqueue 入同一條 promise 鏈 → 嚴格串行（間隔保證）+ 零重複 timer；
//   鏈尾清（chainUsers 歸零 → 鏈重設 Promise.resolve()）防 promise 圖無界生長。
const CWM_MIN_INTERVAL_MS = Math.max(0, Number(process.env.WORKFORCE_MIN_INTERVAL_MS ?? 400));
let lastCwmCallAt = 0;
let cwmChain: Promise<void> = Promise.resolve();
let cwmChainUsers = 0;
async function cwmRateGate(): Promise<void> {
  if (process.env.WORKFORCE_MOCK === "1") return;
  if (CWM_MIN_INTERVAL_MS <= 0) return;
  const prev = cwmChain;
  const mine = prev.then(
    () =>
      new Promise<void>((r) => {
        const wait = lastCwmCallAt + CWM_MIN_INTERVAL_MS - Date.now();
        if (wait > 0) setTimeout(r, wait);
        else r();
      }),
  );
  cwmChainUsers++;
  cwmChain = mine.finally(() => {
    lastCwmCallAt = Date.now();
    if (--cwmChainUsers <= 0) cwmChain = Promise.resolve();
  });
  return mine;
}

async function wfFetch(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  params: Record<string, string>,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  /** ★ cwi-final S5-1：booking-write 長 timeout（預設 = WORKFORCE_TIMEOUT_MS） */
  timeoutMs?: number,
): Promise<unknown> {
  await cwmRateGate();
  const url = new URL(path, process.env.WORKFORCE_API_URL); // http://127.0.0.1:<port>
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "x-api-key": process.env.WORKFORCE_API_KEY ?? "",
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? WORKFORCE_TIMEOUT_MS),
    });
  } catch (err) {
    // timeout / DNS / 拒接 — log 只 path（零 body；err message 唔會含 key）
    log.warn({ path, err: err instanceof Error ? err.name : "network" }, "workforce: fetch failed");
    throw new WorkforceApiError(0, path);
  }
  if (!res.ok) {
    // ★ log 只 path + status（零 body — 401 都唔洩 response 內容）
    let code: string | undefined;
    let retryAfterSec: number | undefined;
    try {
      const j = (await res.json()) as { code?: unknown; retryAfterSec?: unknown };
      if (j && typeof j.code === "string") code = j.code; // 只取分類標籤
      if (j && typeof j.retryAfterSec === "number") retryAfterSec = j.retryAfterSec; // 429 倒數（UI 用）
    } catch {
      /* non-JSON error body（reverse proxy HTML 等）— path+status 已夠 */
    }
    log.warn({ path, status: res.status }, "workforce: non-2xx");
    throw new WorkforceApiError(res.status, path, code, retryAfterSec);
  }
  log.debug({ path, status: res.status }, "workforce: fetch ok");
  return res.json();
}

async function wfGet(
  path: string,
  params: Record<string, string>,
  extraHeaders?: Record<string, string>,
) {
  if (process.env.WORKFORCE_MOCK === "1") return mockFixture(path, params); // §4
  return wfFetch("GET", path, params, undefined, extraHeaders);
}

async function wfSend(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  params: Record<string, string>,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  opts?: { /** ★ cwi-final S5-1：Apricot booking 寫入 — 90s timeout + retry + outcome-unknown 分類 */ bookingWrite?: boolean },
) {
  if (opts?.bookingWrite) {
    return wfSendBookingWrite(method, path, params, body, extraHeaders);
  }
  if (process.env.WORKFORCE_MOCK === "1") return mockFixture(path, params, method, body); // §4
  return wfFetch(method, path, params, body, extraHeaders);
}

/** test-only 出入口：mock 模式下直接打 workforce 端驗證（e.g. status 白名單）— 本 repo 測試用 */
export const wfSendForTest = wfSend;

// ── ★ cwi-final S5-1：booking-write 通道（timeout + retry + outcome-unknown 分類）────────────────

/**
 * booking-write 執行（mock 分支：先記 store = 寫已落，後 sleep = 模擬「回應收唔到」— T670；
 * real 分支：wfFetch 帶 write timeout）。錯誤分類喺外层 wfSendBookingWrite。
 */
async function wfSendBookingWriteOnce(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  params: Record<string, string>,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  if (process.env.WORKFORCE_MOCK === "1") {
    const val = mockFixture(path, params, method, body); // 決定性錯誤（SLOT_TAKEN/WRITE_DISABLED/…）即刻 throw
    const clinicCode = (body as { clinicCode?: unknown } | undefined)?.clinicCode ?? params.clinicCode ?? "";
    const slowMs = mockWriteSlowDelayMs(typeof clinicCode === "string" ? clinicCode : "");
    if (slowMs > 0) await sleep(slowMs); // 寫已落 store，回應「遲咗」— 由外层 race write timeout
    return val;
  }
  return wfFetch(method, path, params, body, extraHeaders, WORKFORCE_WRITE_TIMEOUT_MS);
}

/**
 * booking-write 主通道：
 * - timeout / 網絡（status 0）/ 500 / 502(非 MANUAL_RECONCILE) → WorkforceOutcomeUnknown（安全方向）
 * - 409 IN_PROGRESS / 503 APRICOT_BUSY → 等 WORKFORCE_WRITE_RETRY_DELAY_MS 同 key 重試（≤3）→ 再唔得 UNKNOWN
 * - 確定性錯誤（SLOT_TAKEN / IDEMPOTENCY_* / MANUAL_RECONCILE / 422 / 400 / 403 / 404 / 503 WRITE_DISABLED…）→ 原樣 throw
 */
async function wfSendBookingWrite(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  params: Record<string, string>,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) {
      log.info({ path, attempt, delayMs: WORKFORCE_WRITE_RETRY_DELAY_MS }, "workforce: booking-write retry（409 IN_PROGRESS / 503 APRICOT_BUSY）");
      await sleep(WORKFORCE_WRITE_RETRY_DELAY_MS);
    }
    try {
      return await withTimeout(
        wfSendBookingWriteOnce(method, path, params, body, extraHeaders),
        WORKFORCE_WRITE_TIMEOUT_MS,
        path,
      );
    } catch (e) {
      if (e instanceof WfTimeoutError) {
        log.warn({ path, attempt, timeoutMs: e.timeoutMs }, "workforce: booking-write timeout → outcome unknown");
        throw new WorkforceOutcomeUnknown(path, e);
      }
      if (e instanceof WorkforceApiError) {
        const retriable = (e.status === 409 && e.code === "IN_PROGRESS") || (e.status === 503 && e.code === "APRICOT_BUSY");
        if (retriable) {
          if (attempt < 3) continue;
          log.warn({ path, attempt, status: e.status, code: e.code }, "workforce: booking-write retries exhausted → outcome unknown");
          throw new WorkforceOutcomeUnknown(path, e);
        }
        if (e.status === 0 || e.status === 500 || (e.status === 502 && e.code !== "MANUAL_RECONCILE")) {
          log.warn({ path, attempt, status: e.status, code: e.code ?? null }, "workforce: booking-write 非確定性錯誤 → outcome unknown");
          throw new WorkforceOutcomeUnknown(path, e);
        }
        throw e; // 確定性錯誤 — 原樣（路由按 code 分支）
      }
      // 其他（zod parse / 內部異常）— 回應唔符合 contract 或本地異常 → 安全方向當 UNKNOWN
      log.warn({ path, attempt, err: e instanceof Error ? e.message : String(e) }, "workforce: booking-write 未預期錯誤 → outcome unknown");
      throw new WorkforceOutcomeUnknown(path, e);
    }
  }
  // 唔會到呢度（loop 內必 return/throw）
  throw new WorkforceOutcomeUnknown(path, new Error("retries exhausted"));
}

// ── 公開 API ─────────────────────────────────────────────────────────────

export async function fetchAvailability(
  clinicCode: string,
  from: string,
  to: string,
  providerApricotId?: string
): Promise<WorkforceAvailability> {
  const raw = await wfGet(
    "/api/external/v1/availability",
    { clinicCode, from, to, ...(providerApricotId ? { providerApricotId } : {}) }
  );
  // zod = contract 執行點；parse fail 當 API fail 處理（§3 降級）
  return AvailabilityResponse.parse(raw);
}

// ── 強制刷新空檔 cache（cwi-refresh-20260831 §2/§4 — S1 端點 contract 逐項對齊）──
const RefreshResponse = z.object({
  v: z.literal(1),
  refreshed: z.array(
    z.object({
      date: z.string(),
      ok: z.boolean(),
      syncedAt: z.string().nullable().optional(),
      error: z.string().optional(),
    }),
  ),
  durationMs: z.number().int(),
});
export type RefreshResult = z.infer<typeof RefreshResponse>;

/**
 * 強制刷新 workforce availability cache（POST /availability/refresh）。
 * dates 1..7 個 YYYY-MM-DD（F 側上限 7 — 超出 400）。
 * 錯誤：429 RATE_LIMITED（retryAfterSec）/ 409 APRICOT_BUSY / 404 CLINIC_NOT_FOUND /
 * 403 FORBIDDEN（scope 未加）/ 400 BAD_REQUEST — 均 throw WorkforceApiError。
 */
export async function refreshAvailability(clinicCode: string, dates: string[]): Promise<RefreshResult> {
  const raw = await wfSend("POST", "/api/external/v1/availability/refresh", {}, { v: 1, clinicCode, dates });
  return RefreshResponse.parse(raw);
}

export async function fetchDutyRoster(clinicCode: string, date: string): Promise<WorkforceDuty> {
  return DutySchema.parse(await wfGet("/api/external/v1/duty-roster", { clinicCode, date }));
}

// ── 寫入 + patient-context API（booking-ui MD §1 — contract 同 clinic-workforce 源碼一字一樣）──

/**
 * 代落單（staff 揾住舊客 → POST /v1/bookings）。
 * patient 傳 { patientApricotId }（舊客）— 第一期 UI 唔會傳 { name, phone }（新客）；
 * 409 SLOT_TAKEN / 422 NEW_PATIENT_DISABLED / 503 WRITE_DISABLED 由路由層映射（MD §3）。
 */
export async function createBooking(p: {
  idempotencyKey: string;
  clinicCode: string;
  providerApricotId: string;
  date: string; // YYYY-MM-DD（clinic 時區）
  start: string; // HH:mm
  durationMin: number;
  visitReasonId: string;
  remarks?: string;
  patient: { patientApricotId: string } | { name: string; phone: string };
}): Promise<BookingCreateResult> {
  const body = {
    v: 1 as const,
    idempotencyKey: p.idempotencyKey,
    clinicCode: p.clinicCode,
    providerApricotId: p.providerApricotId,
    date: p.date,
    start: p.start,
    durationMin: p.durationMin,
    visitReasonId: p.visitReasonId,
    ...(p.remarks ? { remarks: p.remarks } : {}),
    patient: p.patient,
  };
  const raw = await wfSend("POST", "/api/external/v1/bookings", {}, body, undefined, { bookingWrite: true }); // ★ cwi-final S5-1
  const res = BookingCreateResponse.parse(raw);
  // ★ cwi-refresh-20260831 §3：寫入成功 → 該日 L2 即時 bust + 重填（fail-soft — 永不 throw）
  if (res.dayRefreshed) await invalidateAvailabilityDay(p.clinicCode, p.date);
  return res;
}

/** 改狀態（白名單 102 / -7 — 其他 workforce 400）。
 * ★ cwi-final S5-8②（F2）：可選 idempotencyKey — commit 後 102 舊單冪等（重試同 key = 同一結果）。 */
export async function updateBookingStatus(
  apricotApptId: string,
  status: 102 | -7,
  p: { clinicCode: string; date: string },
  idempotencyKey?: string,
): Promise<BookingStatusResult> {
  const raw = await wfSend(
    "PUT",
    `/api/external/v1/bookings/${encodeURIComponent(apricotApptId)}/status`,
    { status: String(status), date: p.date, clinicCode: p.clinicCode },
    undefined,
    idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
    { bookingWrite: true }, // ★ cwi-final S5-1
  );
  const res = BookingStatusResponse.parse(raw);
  if (res.dayRefreshed) await invalidateAvailabilityDay(p.clinicCode, p.date);
  return res;
}

/** 刪 appointment（rollback 路徑 — 撤銷代落單） */
export async function removeBooking(
  apricotApptId: string,
  p: { clinicCode: string; date: string }
): Promise<BookingRemoveResult> {
  const raw = await wfSend(
    "PUT",
    `/api/external/v1/bookings/${encodeURIComponent(apricotApptId)}/remove`,
    { date: p.date, clinicCode: p.clinicCode },
    undefined,
    undefined,
    { bookingWrite: true }, // ★ cwi-final S5-1
  );
  const res = BookingRemoveResponse.parse(raw);
  if (res.dayRefreshed) await invalidateAvailabilityDay(p.clinicCode, p.date);
  return res;
}

/** 改期（workforce 原子 102 舊單 + 新落單；409 = 新時段撞） */
export async function rescheduleBooking(
  apricotApptId: string,
  p: {
    clinicCode: string;
    providerApricotId: string;
    date: string;
    start: string;
    durationMin: number;
    oldDate: string;
    patient: { patientApricotId: string } | { name: string; phone: string };
    visitReasonId?: string;
    remarks?: string;
  },
  // ★ cwi-final S5-7（F2）：Idempotency-Key = sha256(flowToken)（caller 算好傳入；唔自動重試 —
  //   WorkforceOutcomeUnknown 由 caller fetchAppointments 對賬後再決定）
  idempotencyKey?: string,
): Promise<BookingRescheduleResult> {
  const body = {
    v: 1 as const,
    clinicCode: p.clinicCode,
    providerApricotId: p.providerApricotId,
    date: p.date,
    start: p.start,
    durationMin: p.durationMin,
    oldDate: p.oldDate,
    patient: p.patient,
    ...(p.visitReasonId ? { visitReasonId: p.visitReasonId } : {}),
    ...(p.remarks ? { remarks: p.remarks } : {}),
  };
  const raw = await wfSend(
    "POST",
    `/api/external/v1/bookings/${encodeURIComponent(apricotApptId)}/reschedule`,
    {},
    body,
    idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
    { bookingWrite: true }, // ★ cwi-final S5-1
  );
  const res = BookingRescheduleResponse.parse(raw);
  // reschedule 兩日都要：舊日 + 新日
  if (res.dayRefreshed) {
    await invalidateAvailabilityDay(p.clinicCode, p.oldDate);
    await invalidateAvailabilityDay(p.clinicCode, p.date);
  }
  return res;
}

/**
 * Dictionaries（VISIT_REASON / BOOKING_TYPE）— 1 小時 memory cache（MD §1）。
 * cache 跨 request 存活（同 process）；clearDictionariesCache 供測試。
 */
const DICT_CACHE_MS = 60 * 60 * 1000;
let dictCache: { at: number; byKind: Partial<Record<"VISIT_REASON" | "BOOKING_TYPE", DictionariesResult>> } | null = null;

export function clearDictionariesCache(): void {
  dictCache = null;
}

export async function fetchDictionaries(kind: "VISIT_REASON" | "BOOKING_TYPE"): Promise<DictionariesResult> {
  if (dictCache && Date.now() - dictCache.at < DICT_CACHE_MS && dictCache.byKind[kind]) {
    return dictCache.byKind[kind] as DictionariesResult;
  }
  const result = DictionariesResponse.parse(await wfGet("/api/external/v1/dictionaries", { kind }));
  dictCache = { at: Date.now(), byKind: { ...(dictCache?.byKind ?? {}), [kind]: result } };
  return result;
}

/**
 * ★ cwi-followup-p0-20260915（MD §1.1）：公司主資料（wa-inbox Company 快取來源）。
 * 唔設 cache — 同步 job 直接 call（03:00 cron + 手動「立即同步」）。
 */
export async function fetchCompanies(): Promise<CompaniesResult> {
  return CompaniesResponse.parse(await wfGet("/api/external/v1/companies", {}));
}

/** 舊客匹配（phoneHash — 由 wa-inbox 用 PHONE_HASH_KEY 算好先傳；raw phone 永遠唔出 wa-inbox） */
export async function lookupPatient(phoneHash: string): Promise<PatientLookupResult> {
  return PatientLookupResponse.parse(await wfGet("/api/external/v1/patient-lookup", { phoneHash }));
}

/**
 * 病人 appointments（patient-context 側欄 — upcoming 過濾喺 wa-inbox 做）。
 * from/to = YYYY-MM-DD（clinic 時區）；workforce 限制 ≤38 天窗口（超出 400）。
 */
export async function fetchAppointments(phoneHash: string, from: string, to: string): Promise<AppointmentsResult> {
  return AppointmentsResponse.parse(
    await wfGet("/api/external/v1/appointments", { phoneHash, from, to })
  );
}

// ── P2 病人記錄 fetcher（followup-v2 MD §2.6 — 全部 scope patients/appointments）──
// 🔴 鐵律：wa-inbox 唔存臨床全文（#5 全文即時撞，收埋唔 cache）；展開 audit 落 CWM 側
//    （EXTERNAL_NOTE_VIEWED — W 只傳 X-Staff-Id opaque，唔自己再記內容 audit）。

/** #4 病人到診列表（結構化 + firstLine ≤60 字；404 NOT_FOUND = 零索引行）。 */
export async function fetchPatientVisits(patientApricotId: string, limit = 50): Promise<PatientVisitsResult> {
  return PatientVisitsResponse.parse(
    await wfGet(`/api/external/v1/patients/${encodeURIComponent(patientApricotId)}/visits`, { limit: String(limit) })
  );
}

/** #1 病人到診 batch（MD §2.6 #1 — C/D 引擎觸發來源；≤366 日窗口）。 */
export async function fetchClinicVisits(
  clinicCode: string,
  from: string,
  to: string,
  opts?: { reasonCodes?: string[]; bookingStatuses?: number[] }
): Promise<BatchVisitsResult> {
  const params: Record<string, string> = { clinicCode, from, to };
  (opts?.reasonCodes ?? []).forEach((c) => appendAll(params, "reasonCodes", c));
  (opts?.bookingStatuses ?? []).forEach((b) => appendAll(params, "bookingStatus", String(b)));
  return BatchVisitsResponse.parse(await wfGet(`/api/external/v1/patients/visits`, params));
}
function appendAll(params: Record<string, string>, key: string, val: string): void {
  params[key] = params[key] ? `${params[key]},${val}` : val;
}

/** E 類報價查詢（CWM /quotes — per patient 或 batch；零原始電話）。
 *  ★ cwi-final S5-13①：加 clinicIds（cuid）/ clinicCodes（shortName 兼容）— CWM 端 `where.clinicId in` 服務端 filter。 */
export async function fetchQuotes(opts?: {
  patientApricotId?: string;
  status?: string;
  limit?: number;
  clinicIds?: string[];
  clinicCodes?: string[];
}): Promise<QuotesResult> {
  const params: Record<string, string> = {};
  if (opts?.patientApricotId) params.patientApricotId = opts.patientApricotId;
  if (opts?.status) params.status = opts.status;
  if (opts?.limit) params.limit = String(opts.limit);
  if (opts?.clinicIds?.length) params.clinicIds = opts.clinicIds.join(",");
  if (opts?.clinicCodes?.length) params.clinicCodes = opts.clinicCodes.join(",");
  return QuotesResponse.parse(await wfGet(`/api/external/v1/quotes`, params));
}

/** ★ cwi-final S5-13①：單條報價（CWM GET /quotes/{id} — 同列表 item shape）。 */
export async function fetchQuote(id: string): Promise<WorkforceQuote> {
  return QuoteSchema.parse(await wfGet(`/api/external/v1/quotes/${encodeURIComponent(id)}`, {}));
}

/** 報價確認隊列決定：✓ confirm / ✎ correct / ✗ discard（teachTerm = 順手教字典）。 */
export async function decideQuote(
  id: string,
  body: {
    action: "confirm" | "correct" | "discard";
    fields?: { amountMin?: number; amountMax?: number; termShorthand?: string | null; nameCn?: string; text?: string; /** ★ cwi-final S0-7：workforce decision route 對 correct 讀 fields.correctionNote（兩口徑兼容） */ correctionNote?: string };
    teachTerm?: { shorthand: string; nameCn: string; nameEn?: string; usedFor?: string[] };
    correctionNote?: string;
    decidedBy?: string;
  }
): Promise<QuoteDecisionResult> {
  return QuoteDecisionResponse.parse(
    await wfSend("POST", `/api/external/v1/quotes/${encodeURIComponent(id)}/decision`, {}, body)
  );
}

/** 術語表讀（admin 頁）— CWM /clinical-term-map。 */
export async function fetchTermMap(): Promise<TermMapResult> {
  return TermMapResponse.parse(await wfGet(`/api/external/v1/clinical-term-map`, {}));
}

/** 術語表寫（admin 頁；只詞表可改 — 解析規則唔可編輯）。 */
export async function putTermMap(
  terms: { shorthand: string; nameCn: string; nameEn?: string | null; usedFor?: string[]; active?: boolean }[],
  staffId: string
): Promise<TermMapResult> {
  // ★ cwi-final S3-4（D-5）：x-staff-id header — CWM 側審計用（wfSend 已支援 headers — 同 claimSlot 用法）
  return TermMapResponse.parse(await wfSend("PUT", `/api/external/v1/clinical-term-map`, {}, { terms }, { "x-staff-id": staffId }));
}

// ── cwi-followup-p4 S6：hub 健康警示（索引 job / 電話正規化率 — 零內容狀態）──
export const ClinicalIndexStatusResponse = z.object({
  v: z.literal(1),
  lastNightly: z
    .object({
      status: z.string(),
      finishedAt: z.string().nullable(),
      errors: z.number().int(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  phoneNormalize: z.object({ total: z.number().int(), withHash: z.number().int(), rate: z.number().nullable() }),
});
export type ClinicalIndexStatus = z.infer<typeof ClinicalIndexStatusResponse>;

/** hub 健康警示：最近 NIGHTLY 索引 job + phoneHashes 正規化率（CWM 側算，零內容）。 */
export async function fetchClinicalIndexStatus(): Promise<ClinicalIndexStatus> {
  return ClinicalIndexStatusResponse.parse(await wfGet(`/api/external/v1/clinical-index/status`, {}));
}

/**
 * #5 臨床全文（MD §2.4 紅線）：CWM 側 100% 落 EXTERNAL_NOTE_VIEWED audit（staffId + visitId，零內容）。
 * staffId = wa-inbox StaffUser.id（opaque 傳；唔入 log）。
 */
export async function fetchVisitNote(patientApricotId: string, visitId: string, staffId: string): Promise<VisitNoteResult> {
  const path = `/api/external/v1/patients/${encodeURIComponent(patientApricotId)}/visits/${encodeURIComponent(visitId)}/note`;
  return VisitNoteResponse.parse(await wfGet(path, {}, { "x-staff-id": staffId }));
}

/** #6 病人帳單總額（billTtlAmt/billOsAmt；404 PATIENT_NOT_FOUND = 無索引行）。 */
export async function fetchPatientBalance(patientApricotId: string): Promise<PatientBalanceResult> {
  return PatientBalanceResponse.parse(
    await wfGet(`/api/external/v1/patients/${encodeURIComponent(patientApricotId)}/balance`, {})
  );
}

/**
 * #3 appointments clinic 模式（MD §2.6 #3）：該診所該窗全部預約（含 phoneHashes[]）。
 * from/to ≤38 日窗口（超出 400）；404 NOT_FOUND = 诊所唔存在。
 */
export async function fetchAppointmentsByClinic(clinicCode: string, from: string, to: string): Promise<ClinicAppointmentsResult> {
  return ClinicAppointmentsResponse.parse(
    await wfGet("/api/external/v1/appointments", { clinicCode, from, to })
  );
}

/** #8 手動刷新單一病人（MD §2.8）：即時打 Apricot 三條唯讀 → upsert 索引。429 = 60s 限流（retryAfterSec）。 */
export async function refreshPatient(patientApricotId: string): Promise<PatientRefreshResult> {
  return PatientRefreshResponse.parse(
    await wfSend("POST", `/api/external/v1/patients/${encodeURIComponent(patientApricotId)}/refresh`, {})
  );
}

// ── bookable-slots（providerslot-20260830 — T3/T4 reusable）─────────────

/**
 * 可約時段讀（MD 3.1）— 前台四態格 + Flow PICK_DATE/PICK_TIME 用。
 * 約束（workforce 端）：from 必須 ≥ today（否則 400）；to 超 clinic.flowWindowDays 會 clamp；
 * 只回 offerable 格（滿/lead-time/未開診 唔入 payload）。
 */
export async function getBookableSlots(clinicCode: string, from: string, to: string): Promise<BookableSlotsResult> {
  return BookableSlotsResponse.parse(
    await wfGet("/api/external/v1/bookable-slots", { clinicCode, from, to })
  );
}

/**
 * held PII-free 讀（T3 警報 — 零病人資料）。
 * ★ response 無 clinicCode → 逐店 call（clinicCode 必傳；唔傳 = 全店，警報要 clinic 欄所以唔用）。
 */
export async function getHeld(clinicCode: string): Promise<HeldResult> {
  return HeldResponse.parse(await wfGet("/api/external/v1/bookable-slots/held", { clinicCode }));
}

/** commit（MD 3.3）— 前台已入 Apricot：workforce HELD → IN_APRICOT（冪等）。 */
export async function commitHold(holdId: string, apricotRef?: string): Promise<HoldCommitResult> {
  if (!slotClaimEnabled()) throw new SlotClaimDisabledError("/api/external/v1/bookable-slots/claim/:holdId/commit"); // S0-12
  return HoldCommitResponse.parse(
    await wfSend("POST", `/api/external/v1/bookable-slots/claim/${encodeURIComponent(holdId)}/commit`, {}, apricotRef ? { apricotRef } : undefined)
  );
}

/** release（MD 3.3）— ★ cwi-final S5-11（F4）：wa-inbox 自己放 hold（FlowSession ABANDONED 48h 清理）。
 *  S0-12 閘唔擋（spec 明確：release 唔入 G2 claim/commit — 否則棄單 hold 永遠放唔晒）；冪等（已 RELEASED → 200 同狀）。 */
export async function releaseHold(holdId: string): Promise<HoldReleaseResult> {
  return HoldReleaseResponse.parse(
    await wfSend("DELETE", `/api/external/v1/bookable-slots/claim/${encodeURIComponent(holdId)}`, {})
  );
}

/**
 * claim（MD 3.2 / providerslot T4）— 佔位硬保留（Flow 三屏 submit_confirm 內 call）。
 * - 冪等：Idempotency-Key = claim token（T1 契約）— Meta 重試同 token 同 slot → 同 holdId（唔佔兩個位）
 * - 409 slot_taken（真 T1 body 無 code 欄）/ 409 flow_token_reused（code=FLOW_TOKEN_REUSED；同 token 唔同 slot）→ WorkforceApiError；
 *   flow 端收 409 後重拉 bookable-slots 重導 SCR_SLOT（全列表比 409 body 嘅 alternatives 完整）
 * - 🔴 response 零 PII 回顯
 */
export async function claimSlot(p: {
  slotKey: string;
  patientWaId: string;
  patientName?: string | null;
  /** inbox flow_token（HS256 JWT）— 內部派生 64hex claim token（T1 上限 128 字元；JWT ~215） */
  flowToken: string;
}): Promise<ClaimResult> {
  const path = "/api/external/v1/bookable-slots/claim";
  if (!slotClaimEnabled()) throw new SlotClaimDisabledError(path); // S0-12
  const claimToken = deriveClaimToken(p.flowToken);
  const raw = await wfSend(
    "POST",
    path,
    {},
    {
      v: 1,
      slotKey: p.slotKey,
      patient: { waId: p.patientWaId, ...(p.patientName ? { name: p.patientName } : {}) },
      source: "whatsapp_flow",
      flowToken: claimToken,
    },
    { "idempotency-key": claimToken },
  );
  return ClaimResponse.parse(raw);
}

/**
 * flow_token（HS256 JWT ~215 字元）→ 64 字元穩定 hash（T1 flowToken 上限 8-128 字元）。
 * 同一 JWT → 同一派生值（冪等語義不變）；不同對話 / 不同 flow → 唔同。
 */
export function deriveClaimToken(flowToken: string): string {
  return createHash("sha256").update(flowToken).digest("hex");
}

/**
 * 預設 visit reason（env BOOKING_DEFAULT_VISIT_REASON_CODE）。
 * TODO（cwi-bkui-20260823-a1）：0010 定 0021 — 老細上線前拍板後寫入 .env（現留空 = 無預設）。
 * 空 = null（UI 唔設 preselect；create route 两边都冇 → 400 提示）。
 */
export function defaultVisitReasonCode(): string | null {
  const v = (process.env.BOOKING_DEFAULT_VISIT_REASON_CODE ?? "").trim();
  return v.length > 0 ? v : null;
}

// ── Mock（§4 — WORKFORCE_MOCK=1；決定性，E2E 斷言用）────────────────────
//
// 設計：
// - fixture 檔（test/fixtures/external-v1-availability.json）= contract shape 錨（sha256 對照）；
//   mock runtime 由佢派生：clinicCode 跟 request、providers 跟本 DB Provider 名錄（seed 派生嘅
//   mock-pract-<clinic>-<n>）— 同一套決定性 hash 規則（沿用舊 mock：閉诊日 ~1/7、
//   滿位 ~1/4）→ E2E flow 全鏈可行（seed 名錄同 mock slot 對得上）。
// - 控制旗（flag file — E2E 運行時切換，唔使重啟 process）：
//   .dev/workforce-mock-fail.json   { clinicCode }        → 該店 mock 直接 throw（測 §3 層 3/4）
//   .dev/workforce-mock-stale.json  { clinicCode }        → 該店 mock 回 stale=true + 舊 syncedAt
//   .dev/workforce-mock-fill.json   [ {clinicCode, providerApricotId, date, startTime, remainingCapacity?} ]
//                                       → 指定 slot 標滿（測「flow 中途變滿」precheck 路徑）；
//                                       §D（cwi-r2）：帶 remainingCapacity = 該 slot base 容量（唔標滿，純容量治理 → 遞減測試用）
//   寫入端點旗（booking-ui MD §1）：
//   .dev/workforce-mock-write-disabled.json  { clinicCode? }  → 該店（或全店）POST/PUT → 503 WRITE_DISABLED
//   .dev/workforce-mock-newpatient.json      { on: true }     → 允許 {name,phone} 新客 body（Stage 1 預設 off → 422）
//   .dev/workforce-mock-slot-taken.json      [ {clinicCode, providerApricotId, date, start} ]
//                                          → create/reschedule 撞該 slot → 409 SLOT_TAKEN
//   病人數據（patient-lookup / appointments 端點）：
//   .dev/workforce-mock-patients.json  { byPhoneHash: { <64hex>: { matches?, appointments? } } }
//                                          → runtime 覆蓋 committed fixture（e2e 寫入；唔入 git）
// - env 旗：WORKFORCE_MOCK_FAIL=1 / WORKFORCE_MOCK_STALE=1 / WORKFORCE_MOCK_WRITE_DISABLED=1 /
//   WORKFORCE_MOCK_NEW_PATIENT_ON=1（全店，手動測用）
// - 決定性：mock-appt id = mock-appt-<djb2(key)>（冪等重放同 id）；dictionaries/lookup/appointments
//   = committed fixture（test/fixtures/external-v1-*.json，sha256 錨定）＋ runtime 檔 merge

export const MOCK_FAIL_FLAG = ".dev/workforce-mock-fail.json";
export const MOCK_STALE_FLAG = ".dev/workforce-mock-stale.json";
export const MOCK_FILL_FLAG = ".dev/workforce-mock-fill.json";
export const MOCK_WRITE_DISABLED_FLAG = ".dev/workforce-mock-write-disabled.json";
export const MOCK_NEW_PATIENT_FLAG = ".dev/workforce-mock-newpatient.json";
export const MOCK_SLOT_TAKEN_FLAG = ".dev/workforce-mock-slot-taken.json";
export const MOCK_HELD_FLAG = ".dev/workforce-mock-held.json";
// cwi-sched-20260901 T150：mock base day 加 N 個醫生（>3 收埋分支測試用；缺檔 = 0）
export const MOCK_EXTRA_PROVIDERS_FLAG = ".dev/workforce-mock-extra-providers.json"; // [{ clinicCode, extra }]
export const MOCK_PATIENTS_FILE = ".dev/workforce-mock-patients.json";
// ★ cwi-followup-p3-20260916：follow-up e2e 動態 fixture（e2e 寫入相對日期 — 明日預約/前日爽約）
//   { appointments?: [{ clinicCode, date, start, end, providerApricotId, providerName, patientApricotId, bookingStatus, apricotApptId, phoneHashes? }],
//     balances?: { <cpId>: { osAmt: number|null, ttlAmt?: number|null } } }
export const MOCK_FOLLOWUP_FLAG = ".dev/workforce-mock-followup.json";
// T4：mock claim hold store（決定性；零 PII；e2e 完清檔）
export const MOCK_CLAIMS_FILE = ".dev/workforce-mock-claims.json";
// P2 病人記錄 mock 控制旗（e2e 斷言用；gitignored）：
export const MOCK_SYNC_FLAG = ".dev/workforce-mock-sync.json"; // { offsetHours?: number } — syncedAt = now - offset（default 5h = 灰「正常」態）
export const MOCK_REFRESH_FLAG = ".dev/workforce-mock-refresh.json"; // { mode?: "ok"|"fail"|"rate", retryAfterSec?: number }
// §D（cwi-r2）：mock booking store（create 後 capacity 遞減 / remove 還原）— 決定性，e2e cleanup 清檔
export const MOCK_BOOKED_FILE = ".dev/workforce-mock-booked.json";
// cwi-refresh-20260831：mock refresh 端點錯誤旗（shape 逐項對齊 S1 真端點 contract）
export const MOCK_REFRESH_429_FLAG = ".dev/workforce-mock-refresh-429.json"; // { clinicCode? } → 429 RATE_LIMITED + retryAfterSec
export const MOCK_REFRESH_409_FLAG = ".dev/workforce-mock-refresh-409.json"; // { clinicCode? } → 409 APRICOT_BUSY
export const MOCK_REFRESH_404_FLAG = ".dev/workforce-mock-refresh-404.json"; // { clinicCode? } → 404 CLINIC_NOT_FOUND
export const MOCK_REFRESH_403_FLAG = ".dev/workforce-mock-refresh-403.json"; // { clinicCode? } → 403 FORBIDDEN（scope 未加）
export const MOCK_CLINICAL_FLAG = ".dev/workforce-mock-clinical.json"; // cwi-followup-p4：{ visits?, quotes?, terms? } — C/D/E + 術語表 mock
export const MOCK_REFRESH_400_FLAG = ".dev/workforce-mock-refresh-400.json"; // { clinicCode? } → 400 BAD_REQUEST
export const MOCK_REFRESH_FAILDAY_FLAG = ".dev/workforce-mock-refresh-failday.json"; // [date, ...] → 該日 ok:false（逐日失敗 UI）
// 寫入 mock 回 dayRefreshed:false（T145：唔 bust 斷言）
export const MOCK_DAYREFRESHED_OFF_FLAG = ".dev/workforce-mock-dayrefreshed-off.json"; // { on: true }
// ★ cwi-final S5-1（T670）：mock write-slow 旗 — booking-write「寫已落 store、回應遲到」（模擬 Apricot 寫入慢/timeout）
//   { clinicCode?, delayMs? }（delayMs 預設 100000）— e2e 設 WORKFORCE_WRITE_TIMEOUT_MS 遠小於 delayMs → UNKNOWN 路徑
export const MOCK_WRITE_SLOW_FLAG = ".dev/workforce-mock-write-slow.json";
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/external-v1-availability.json");
const FIXTURE_DICTIONARIES_PATH = path.resolve(process.cwd(), "test/fixtures/external-v1-dictionaries.json");
const FIXTURE_PATIENT_LOOKUP_PATH = path.resolve(process.cwd(), "test/fixtures/external-v1-patient-lookup.json");
const FIXTURE_APPOINTMENTS_PATH = path.resolve(process.cwd(), "test/fixtures/external-v1-appointments.json");

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

// ── §D（cwi-r2）mock booking store（capacity 遞減）─────────────────────

interface MockBookedEntry {
  apricotApptId: string;
  clinicCode: string;
  providerApricotId: string;
  date: string;
  start: string;
}

function readBookedStore(): MockBookedEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(process.cwd(), MOCK_BOOKED_FILE), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.apricotApptId === "string") : [];
  } catch {
    return [];
  }
}

function writeBookedStore(entries: MockBookedEntry[]): void {
  try {
    writeFileSync(path.resolve(process.cwd(), MOCK_BOOKED_FILE), JSON.stringify(entries, null, 1));
  } catch {
    /* best-effort — 寫唔到 = 無遞減（e2e 斷言會 red） */
  }
}

/** create 成功 → 記 store（同 apricotApptId 冪等重放唔重複計）。 */
function recordBooked(e: MockBookedEntry): void {
  const store = readBookedStore();
  if (store.some((x) => x.apricotApptId === e.apricotApptId)) return;
  writeBookedStore([...store, e]);
}

/** remove/reschedule → 清該 booking。 */
function forgetBooked(apricotApptId: string): void {
  const store = readBookedStore();
  const next = store.filter((x) => x.apricotApptId !== apricotApptId);
  if (next.length !== store.length) writeBookedStore(next);
}

/** 該 slot 已被 mock book 幾多次（capacity 遞減用）。 */
function bookedCountAt(clinicCode: string, providerApricotId: string, date: string, start: string): number {
  return readBookedStore().filter(
    (b) => b.clinicCode === clinicCode && b.providerApricotId === providerApricotId && b.date === date && b.start === start
  ).length;
}

function readFlag<T>(rel: string, pred: (f: T) => boolean): T | null {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(process.cwd(), rel), "utf8"));
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const hit = arr.find((f) => f && pred(f));
    return hit ?? null;
  } catch {
    return null;
  }
}

function readFillFlags(): { clinicCode: string; providerApricotId: string; date: string; startTime: string; remainingCapacity?: number }[] {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(process.cwd(), MOCK_FILL_FLAG), "utf8"));
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter(
        (f) =>
          f &&
          typeof f.clinicCode === "string" &&
          typeof f.providerApricotId === "string" &&
          typeof f.date === "string" &&
          typeof f.startTime === "string"
      )
      // §D：flag 可帶 remainingCapacity（base 容量）— 非數字忽略（視為無）
      .map((f) => ({ ...f, remainingCapacity: typeof f.remainingCapacity === "number" ? f.remainingCapacity : undefined }));
  } catch {
    return [];
  }
}

function mockFixture(path: string, params: Record<string, string>, method?: "POST" | "PUT" | "DELETE", body?: unknown): unknown {
  try {
    const out = mockFixtureImpl(path, params, method, body);
    mockCallLog(method ?? "GET", path, 200);
    return out;
  } catch (e) {
    mockCallLog(method ?? "GET", path, e instanceof WorkforceApiError ? e.status : 500);
    throw e;
  }
}

/** e2e 斷言用：mock 調用記錄（只 method+path+status — 零 body / 零 PII；gitignored） */
export const MOCK_CALLS_LOG = ".dev/workforce-mock-calls.jsonl";
function mockCallLog(method: string, reqPath: string, status: number): void {
  try {
    appendFileSync(
      path.resolve(process.cwd(), MOCK_CALLS_LOG),
      JSON.stringify({ method, path: reqPath.split("?")[0], status, ts: new Date().toISOString() }) + "\n"
    );
  } catch {
    /* best-effort — 寫唔到 e2e 斷言會 red */
  }
}

function mockFixtureImpl(path: string, params: Record<string, string>, method?: "POST" | "PUT" | "DELETE", body?: unknown): unknown {
  // 全店 fail 旗（env）
  if (process.env.WORKFORCE_MOCK_FAIL === "1") {
    log.info({ path, mock: true }, "workforce MOCK: fail（WORKFORCE_MOCK_FAIL=1）");
    throw new WorkforceApiError(500, path);
  }

  if (path === "/api/external/v1/availability") {
    const clinicCode = params.clinicCode ?? "";
    const failFlag = readFlag<{ clinicCode?: string }>(MOCK_FAIL_FLAG, (f) => f.clinicCode === clinicCode);
    if (failFlag) {
      log.info({ path, clinic: clinicCode, mock: true }, "workforce MOCK: fail（flag file）");
      throw new WorkforceApiError(500, path);
    }
    return mockAvailability(params);
  }

  if (path === "/api/external/v1/duty-roster") {
    // 決定性 3 人 fixture（同舊 duty client DUTY_MOCK — {v:1, staff:[...]} v1 shape）
    return {
      v: 1,
      staff: [
        { staffName: "林小曼", role: "前台", shiftStart: "09:00", shiftEnd: "17:00" },
        { staffName: "黃詩韻", role: "前台", shiftStart: "13:00", shiftEnd: "21:00" },
        { staffName: "張美玲", role: "護士", shiftStart: "10:00", shiftEnd: "18:00" },
      ],
    };
  }

  // ── 寫入 + patient-context 端點（booking-ui MD §1 — mock 決定性，E2E 斷言用）──

  // cwi-refresh-20260831：強制刷新端點（mock 決定性；錯誤 shape 對齊 S1 真端點）
  if (path === "/api/external/v1/availability/refresh" && method === "POST") {
    return mockAvailabilityRefresh(body);
  }

  if (path === "/api/external/v1/bookings" && method === "POST") {
    return mockCreateBooking(body);
  }

  if (path === "/api/external/v1/dictionaries") {
    return mockDictionaries(params);
  }

  if (path === "/api/external/v1/companies") {
    return mockCompanies();
  }

  if (path === "/api/external/v1/patient-lookup") {
    return mockPatientLookup(params);
  }

  if (path === "/api/external/v1/appointments") {
    // P2：clinic 模式（MD §2.6 #3）— phoneHash 唔傳先行 clinic 路；唔傳 = 400（同真端點）
    if (params.clinicCode) return mockClinicAppointments(params);
    return mockAppointments(params);
  }

  // ── P2 病人記錄端點（followup-v2 MD §2.6 — mock 決定性；數據對齊 CWM dev stub）──
  const p2m = path.match(/^\/api\/external\/v1\/patients\/([^/]+)\/(visits|balance|refresh)$/);
  if (p2m) {
    const cpId = decodeURIComponent(p2m[1]);
    const op = p2m[2];
    if (op === "visits" && !method) return mockPatientVisits(cpId, params);
    if (op === "balance" && !method) return mockPatientBalance(cpId);
    if (op === "refresh" && method === "POST") return mockPatientRefresh(cpId, path);
  }
  const p2note = path.match(/^\/api\/external\/v1\/patients\/([^/]+)\/visits\/([^/]+)\/note$/);
  if (p2note) {
    return mockVisitNote(decodeURIComponent(p2note[1]), decodeURIComponent(p2note[2]), path);
  }

  // ── cwi-followup-p4：C/D/E + 術語表 mock（.dev/workforce-mock-clinical.json — file-backed 決定性）──
  if (path === "/api/external/v1/patients/visits" && !method) {
    return mockClinicVisits(params);
  }
  if (path === "/api/external/v1/quotes" && !method) {
    return mockQuotes(params);
  }
  const qd = path.match(/^\/api\/external\/v1\/quotes\/([^/]+)\/decision$/);
  if (qd && method === "POST") {
    return mockQuoteDecision(decodeURIComponent(qd[1]), body, path);
  }
  if (path === "/api/external/v1/clinical-term-map" && !method) {
    return mockTermMap();
  }
  if (path === "/api/external/v1/clinical-index/status" && !method) {
    return mockIndexStatus();
  }
  if (path === "/api/external/v1/clinical-term-map" && method === "PUT") {
    return mockTermMapPut(body, path);
  }

  // ── bookable-slots（providerslot-20260830 T3 — mock 決定性，E2E/開發用）──

  if (path === "/api/external/v1/bookable-slots") {
    return mockBookableSlots(params);
  }

  if (path === "/api/external/v1/bookable-slots/claim" && method === "POST") {
    return mockClaim(body);
  }

  if (path === "/api/external/v1/bookable-slots/held") {
    // 預設空；.dev/workforce-mock-held.json = runtime 覆蓋（截圖/e2e 控制，唔入 git）
    return { v: 1, generatedAt: new Date().toISOString(), holdTimeoutHours: 24, holds: readMockHolds() };
  }

  const holdCommitM = path.match(/^\/api\/external\/v1\/bookable-slots\/claim\/([^/]+)\/commit$/);
  if (holdCommitM && method === "POST") {
    // T4：claim store 同步推進（HELD → IN_APRICOT）— held mock / hold-sweep 跟狀態；
    // 靜態 flag file 嘅 holdId（T3 截圖 fixture）唔喺 store → no-op（行為唔變）
    markClaimCommitted(decodeURIComponent(holdCommitM[1]));
    return { v: 1, holdId: decodeURIComponent(holdCommitM[1]), status: "IN_APRICOT" as const, committedAt: new Date().toISOString() };
  }

  // ★ cwi-final S5-11（F4）：release（MD 3.3）— FlowSession ABANDONED 自放 hold（mock 決定性；冪等）
  const holdReleaseM = path.match(/^\/api\/external\/v1\/bookable-slots\/claim\/([^/]+)$/);
  if (holdReleaseM && method === "DELETE") {
    markClaimReleased(decodeURIComponent(holdReleaseM[1]));
    return { v: 1, holdId: decodeURIComponent(holdReleaseM[1]), status: "RELEASED" as const, apricotRef: null };
  }

  // /bookings/{id}/status | /remove | /reschedule
  const m = path.match(/^\/api\/external\/v1\/bookings\/([^/]+)\/(status|remove|reschedule)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const op = m[2];
    if (op === "status" && method === "PUT") return mockBookingStatus(id, params);
    if (op === "remove" && method === "PUT") return mockBookingRemove(id, params);
    if (op === "reschedule" && method === "POST") return mockReschedule(id, body);
  }

  throw new WorkforceApiError(404, path);
}

// ── cwi-followup-p4 mock helpers（file-backed — .dev/workforce-mock-clinical.json）──
type MockQuoteRow = {
  id: string;
  patientApricotId: string;
  clinicCode: string;
  sourceVisitDate: string;
  text: string;
  termShorthand: string | null;
  nameCn: string | null;
  amountMin: number | null;
  amountMax: number | null;
  perUnit: boolean;
  fdiTeeth: string[];
  intent: "not_done" | "unknown";
  certainty: "high" | "low";
  source: "parser" | "llm" | "manual";
  status: "pending" | "confirmed" | "corrected" | "discarded";
};
type MockTermRow = {
  id: string;
  shorthand: string;
  nameCn: string;
  nameEn: string | null;
  usedFor: string[];
  active: boolean;
  updatedAt: string;
};
type MockIndexStatus = {
  lastNightly?: { status: string; finishedAt: string | null; errors: number; lastError: string | null } | null;
  phoneNormalize?: { total: number; withHash: number; rate: number | null } | null;
};
type MockQuoteDecisionInput = {
  action?: string;
  fields?: { amountMin?: number; amountMax?: number; termShorthand?: string | null; nameCn?: string; text?: string };
  teachTerm?: { shorthand: string; nameCn: string; nameEn?: string; usedFor?: string[] };
};
type MockTermPutInput = { terms?: (Partial<MockTermRow> & { shorthand: string; nameCn: string })[] };
interface MockClinicalFile {
  visits?: Record<string, unknown>[]; // 與真 #1 batch 輸出同 shape（zod 喺 caller 驗）
  quotes?: MockQuoteRow[];
  terms?: MockTermRow[];
  indexStatus?: MockIndexStatus;
}
function readClinical(): MockClinicalFile {
  try {
    return JSON.parse(readFileSync(path.resolve(process.cwd(), MOCK_CLINICAL_FLAG), "utf8")) as MockClinicalFile;
  } catch {
    return {};
  }
}
function writeClinical(f: MockClinicalFile): void {
  try {
    writeFileSync(path.resolve(process.cwd(), MOCK_CLINICAL_FLAG), JSON.stringify(f, null, 2));
  } catch {
    /* e2e fixture 寫唔到 = 下個斷言 red */
  }
}
/** #1 batch visits（C/D 觸發源；mock 唔做 server-side reasonCodes 過濾 — 引擎口徑唔依賴佢）。 */
function mockClinicVisits(params: Record<string, string>): unknown {
  const f = readClinical();
  // ★ cwi-final S2-1（T427 回歸修復）：真端點按 clinicCode 過濾（fetchClinicVisits 必傳）—
  //   mock 舊狀返回全店 visits → 同病人跨店 visit 混入每店 scan，subjectKey tx:<visitId> 跨店碰撞
  //   → 科目級 ① 誤殺 B-4① 跨店去重。對齊真端點口徑（mockQuotes 先例：status 過濾）。
  let visits = f.visits ?? [];
  if (params.clinicCode) visits = visits.filter((v) => (v.clinicCode as string | undefined) === params.clinicCode);
  return { v: 1, visits };
}
/** E 報價查詢（status 過濾做咗 — 對齊真端點口徑）。 */
function mockQuotes(params: Record<string, string>): unknown {
  const f = readClinical();
  let quotes = f.quotes ?? [];
  const statusRaw = params.status ? params.status.split(",") : null;
  if (statusRaw && statusRaw.length) quotes = quotes.filter((q) => statusRaw.includes(q.status));
  const pid = params.patientApricotId;
  if (pid) quotes = quotes.filter((q) => q.patientApricotId === pid);
  const limit = params.limit ? parseInt(params.limit, 10) : 500;
  return { v: 1, quotes: quotes.slice(0, Number.isFinite(limit) ? limit : 500) };
}
/** 確認隊列決定（file-backed：更新 quote.status → 重掃口徑決定性）。 */
function mockQuoteDecision(id: string, bodyIn: unknown, reqPath: string): unknown {
  const b = (bodyIn ?? {}) as MockQuoteDecisionInput;
  const f = readClinical();
  const quotes = f.quotes ?? [];
  const q = quotes.find((x) => x.id === id);
  if (!q) throw new WorkforceApiError(404, reqPath);
  const statusMap: Record<string, MockQuoteRow["status"]> = { confirm: "confirmed", correct: "corrected", discard: "discarded" };
  const action = typeof b.action === "string" ? b.action : "";
  if (!statusMap[action]) throw new WorkforceApiError(400, reqPath);
  q.status = statusMap[action];
  if (action === "correct" && b.fields) {
    if (typeof b.fields.amountMin === "number") q.amountMin = b.fields.amountMin;
    if (typeof b.fields.amountMax === "number") q.amountMax = b.fields.amountMax;
    if (typeof b.fields.termShorthand === "string") q.termShorthand = b.fields.termShorthand;
    if (b.fields.termShorthand === null) { q.termShorthand = null; q.nameCn = null; }
    if (typeof b.fields.nameCn === "string") q.nameCn = b.fields.nameCn;
  }
  let termMapUpserted = false;
  if (b.teachTerm && typeof b.teachTerm === "object") {
    const terms = f.terms ?? [];
    const t = b.teachTerm;
    const existing = terms.find((x) => x.shorthand === t.shorthand);
    if (existing) {
      existing.nameCn = t.nameCn ?? existing.nameCn;
      if (typeof t.nameEn === "string") existing.nameEn = t.nameEn;
      existing.active = true;
    } else {
      terms.push({ id: `mock-${t.shorthand}`, shorthand: t.shorthand, nameCn: t.nameCn, nameEn: t.nameEn ?? null, usedFor: t.usedFor ?? ["quote_extraction"], active: true, updatedAt: new Date().toISOString() });
    }
    f.terms = terms;
    termMapUpserted = true;
  }
  f.quotes = quotes;
  writeClinical(f);
  return { v: 1, id, status: q.status, termMapUpserted };
}
/** 索引 job / 正規化率（預設 ok — e2e fixture 可用 indexStatus 覆蓋）。 */
function mockIndexStatus(): unknown {
  const f = readClinical();
  const idx = f.indexStatus;
  if (idx) return { v: 1, lastNightly: idx.lastNightly ?? null, phoneNormalize: idx.phoneNormalize ?? { total: 0, withHash: 0, rate: null } };
  return { v: 1, lastNightly: { status: "DONE", finishedAt: new Date().toISOString(), errors: 0, lastError: null }, phoneNormalize: { total: 0, withHash: 0, rate: null } };
}
/** 術語表（預設空 — e2e fixture 自帶）。 */
function mockTermMap(): unknown {
  const f = readClinical();
  return { v: 1, terms: f.terms ?? [] };
}
/** 術語表寫（整批 upsert — file-backed）。 */
function mockTermMapPut(bodyIn: unknown, _reqPath: string): unknown {
  const b = (bodyIn ?? {}) as MockTermPutInput;
  const f = readClinical();
  const terms = f.terms ?? [];
  for (const t of b.terms ?? []) {
    const existing = terms.find((x) => x.shorthand === t.shorthand);
    if (existing) {
      existing.nameCn = t.nameCn ?? existing.nameCn;
      if (t.nameEn !== undefined) existing.nameEn = t.nameEn ?? null;
      if (t.usedFor) existing.usedFor = t.usedFor;
      if (t.active !== undefined) existing.active = t.active;
      existing.updatedAt = new Date().toISOString();
    } else {
      terms.push({ id: `mock-${t.shorthand}`, shorthand: t.shorthand, nameCn: t.nameCn, nameEn: t.nameEn ?? null, usedFor: t.usedFor ?? ["quote_extraction"], active: t.active !== false, updatedAt: new Date().toISOString() });
    }
  }
  f.terms = terms;
  writeClinical(f);
  return { v: 1, terms };
}

// ── mock 寫入端點 helper（決定性；log 同 real mode 一樣只 path+status）──

/** T145：寫入 mock 回 dayRefreshed:false（e2e flag — 斷言「唔 bust」路徑） */
function mockDayRefreshedOff(): boolean {
  return !!readFlag<{ on?: boolean }>(MOCK_DAYREFRESHED_OFF_FLAG, (f) => f.on === true);
}

/**
 * mock /availability/refresh（cwi-refresh-20260831）— 200/429/409/404/403/400 各 shape
 * 逐項對齊 S1 真端點 contract（T4 教訓：client 分支 + mock 對稱地錯 = real-mode 永不命中）。
 */
function mockAvailabilityRefresh(bodyIn: unknown): unknown {
  const path = "/api/external/v1/availability/refresh";
  const b = (bodyIn ?? {}) as { clinicCode?: string; dates?: string[] };
  const c = b.clinicCode;
  const hit = (flag: string) => !!readFlag<{ clinicCode?: string }>(flag, (f) => !f.clinicCode || f.clinicCode === c);
  if (hit(MOCK_REFRESH_403_FLAG)) {
    log.info({ path, mock: true, status: 403 }, "workforce MOCK: refresh 403 FORBIDDEN");
    throw new WorkforceApiError(403, path, "FORBIDDEN");
  }
  if (hit(MOCK_REFRESH_404_FLAG)) {
    log.info({ path, mock: true, status: 404 }, "workforce MOCK: refresh 404 CLINIC_NOT_FOUND");
    throw new WorkforceApiError(404, path, "CLINIC_NOT_FOUND");
  }
  if (hit(MOCK_REFRESH_429_FLAG)) {
    log.info({ path, mock: true, status: 429 }, "workforce MOCK: refresh 429 RATE_LIMITED");
    throw new WorkforceApiError(429, path, "RATE_LIMITED", 37);
  }
  if (hit(MOCK_REFRESH_409_FLAG)) {
    log.info({ path, mock: true, status: 409 }, "workforce MOCK: refresh 409 APRICOT_BUSY");
    throw new WorkforceApiError(409, path, "APRICOT_BUSY");
  }
  if (hit(MOCK_REFRESH_400_FLAG)) {
    log.info({ path, mock: true, status: 400 }, "workforce MOCK: refresh 400 BAD_REQUEST");
    throw new WorkforceApiError(400, path, "BAD_REQUEST");
  }
  if (!Array.isArray(b.dates) || b.dates.length === 0 || b.dates.length > 7) throw new WorkforceApiError(400, path, "BAD_REQUEST");
  // failday flag = JSON array of dates（文件本身就係值）— 唔好用 readFlag：
  // 佢「攞第一個 matching element」語義會返返 date string → 下面 .filter crash → 502（T147 2026-08-31 實測）
  let failDates: string[] = [];
  try {
    // 相對 cwd 讀（mock 只喺 repo root 嘅 e2e/dev process 跑）— 本地 const path 會 shadow node:path，唔好用 path.resolve
    const raw: unknown = JSON.parse(readFileSync(MOCK_REFRESH_FAILDAY_FLAG, "utf8"));
    if (Array.isArray(raw)) failDates = raw.filter((d): d is string => typeof d === "string");
  } catch {
    /* 無 flag */
  }
  const now = new Date().toISOString();
  log.info({ path, mock: true, status: 200, n: b.dates.length, failDays: failDates.filter((d) => b.dates!.includes(d)) }, "workforce MOCK: refresh ok");
  return {
    v: 1,
    refreshed: b.dates!.map((d) =>
      failDates.includes(d) ? { date: d, ok: false, error: "SYNC_FAILED" } : { date: d, ok: true, syncedAt: now },
    ),
    durationMs: 42,
  };
}

type MockBookingBody = {
  v?: number;
  idempotencyKey?: string;
  clinicCode?: string;
  providerApricotId?: string;
  date?: string;
  start?: string;
  durationMin?: number;
  visitReasonId?: string;
  remarks?: string;
  oldDate?: string;
  patient?: { patientApricotId?: string; name?: string; phone?: string };
};

function mockWriteDisabled(path: string, clinicCode: string | undefined): void {
  const hit =
    process.env.WORKFORCE_MOCK_WRITE_DISABLED === "1" ||
    !!readFlag<{ clinicCode?: string }>(MOCK_WRITE_DISABLED_FLAG, (f) => !f.clinicCode || f.clinicCode === clinicCode);
  if (hit) {
    log.info({ path, mock: true, status: 503 }, "workforce MOCK: WRITE_DISABLED");
    throw new WorkforceApiError(503, path, "WRITE_DISABLED");
  }
}

// ★ cwi-final S5-1（T670）：write-slow 延遲（0 = 唔慢）。flag 命中 → 返回 delayMs（預設 100000）。
function mockWriteSlowDelayMs(clinicCode: string): number {
  const f = readFlag<{ clinicCode?: string; delayMs?: number }>(MOCK_WRITE_SLOW_FLAG, (x) => !x.clinicCode || x.clinicCode === clinicCode);
  if (!f) return 0;
  return typeof f.delayMs === "number" && f.delayMs > 0 ? f.delayMs : 100_000;
}

function mockSlotTaken(path: string, b: MockBookingBody): void {
  const flags = readSlotTakenFlags();
  const hit = flags.some(
    (f) =>
      f.clinicCode === b.clinicCode &&
      f.providerApricotId === b.providerApricotId &&
      f.date === b.date &&
      f.start === b.start
  );
  if (hit) {
    log.info({ path, mock: true, status: 409 }, "workforce MOCK: SLOT_TAKEN");
    throw new WorkforceApiError(409, path, "SLOT_TAKEN");
  }
}

function mockNewPatientCheck(path: string, b: MockBookingBody): void {
  const isNewPatient = !!b.patient && typeof b.patient.name === "string" && typeof b.patient.phone === "string";
  if (!isNewPatient) return;
  const on = process.env.WORKFORCE_MOCK_NEW_PATIENT_ON === "1" || !!readFlag<{ on?: boolean }>(MOCK_NEW_PATIENT_FLAG, (f) => f.on === true);
  if (!on) {
    log.info({ path, mock: true, status: 422 }, "workforce MOCK: NEW_PATIENT_DISABLED");
    throw new WorkforceApiError(422, path, "NEW_PATIENT_DISABLED");
  }
}

const MOCK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MOCK_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function mockCreateBooking(bodyIn: unknown): unknown {
  const path = "/api/external/v1/bookings";
  const b = (bodyIn ?? {}) as MockBookingBody;
  if (b.v !== 1 || typeof b.idempotencyKey !== "string" || b.idempotencyKey.length < 8) {
    throw new WorkforceApiError(400, path, "BAD_REQUEST");
  }
  if (!b.clinicCode || !b.providerApricotId || !b.visitReasonId) throw new WorkforceApiError(400, path, "BAD_REQUEST");
  if (typeof b.date !== "string" || !MOCK_DATE_RE.test(b.date) || typeof b.start !== "string" || !MOCK_TIME_RE.test(b.start)) {
    throw new WorkforceApiError(400, path, "BAD_REQUEST");
  }
  if (typeof b.durationMin !== "number" || b.durationMin <= 0) throw new WorkforceApiError(400, path, "BAD_REQUEST");
  if (!b.patient) throw new WorkforceApiError(400, path, "BAD_REQUEST");

  mockWriteDisabled(path, b.clinicCode);
  mockNewPatientCheck(path, b);
  mockSlotTaken(path, b);

  // ★ 冪等：同 idempotencyKey → 同 apricotApptId（決定性，重放可斷言）
  const apricotApptId = `mock-appt-${djb2(b.idempotencyKey).toString(16).padStart(8, "0")}`;
  const patientApricotId =
    typeof b.patient.patientApricotId === "string"
      ? b.patient.patientApricotId
      : `mock-pat-${djb2(`${b.patient?.name}|${b.patient?.phone}`).toString(16).padStart(8, "0")}`;
  // §D：記 mock booking store（之後 availability sync 會遞減該 slot 嘅 remainingCapacity）
  recordBooked({ apricotApptId, clinicCode: b.clinicCode, providerApricotId: b.providerApricotId, date: b.date, start: b.start });
  log.info({ path, mock: true, status: 200 }, "workforce MOCK: booking created");
  return {
    v: 1,
    apricotApptId,
    bookingStatus: 0,
    patientApricotId,
    patientCode: `MOCK${djb2(patientApricotId).toString(16).padStart(6, "0").slice(-6).toUpperCase()}`,
    dayRefreshed: !mockDayRefreshedOff(),
    syncedAt: new Date().toISOString(),
  };
}

function mockBookingStatus(id: string, params: Record<string, string>): unknown {
  const path = `/api/external/v1/bookings/${encodeURIComponent(id)}/status`;
  const status = Number(params.status ?? "");
  if (!Number.isInteger(status) || (status !== 102 && status !== -7)) {
    throw new WorkforceApiError(400, path, "BAD_REQUEST");
  }
  if (!params.date || !params.clinicCode) throw new WorkforceApiError(400, path, "BAD_REQUEST");
  mockWriteDisabled(path, params.clinicCode);
  log.info({ path, mock: true, status: 200 }, "workforce MOCK: booking status updated");
  return { v: 1, bookingStatus: status, dayRefreshed: !mockDayRefreshedOff(), syncedAt: new Date().toISOString() };
}

function mockBookingRemove(id: string, params: Record<string, string>): unknown {
  const path = `/api/external/v1/bookings/${encodeURIComponent(id)}/remove`;
  if (!params.date || !params.clinicCode) throw new WorkforceApiError(400, path, "BAD_REQUEST");
  mockWriteDisabled(path, params.clinicCode);
  forgetBooked(id); // §D：remove → capacity 還原
  log.info({ path, mock: true, status: 200 }, "workforce MOCK: booking removed");
  return { v: 1, removed: true, dayRefreshed: !mockDayRefreshedOff(), syncedAt: new Date().toISOString() };
}

function mockReschedule(id: string, bodyIn: unknown): unknown {
  const path = `/api/external/v1/bookings/${encodeURIComponent(id)}/reschedule`;
  const b = (bodyIn ?? {}) as MockBookingBody;
  if (b.v !== 1 || !b.clinicCode || !b.providerApricotId || !b.oldDate) throw new WorkforceApiError(400, path, "BAD_REQUEST");
  if (typeof b.date !== "string" || !MOCK_DATE_RE.test(b.date) || typeof b.start !== "string" || !MOCK_TIME_RE.test(b.start)) {
    throw new WorkforceApiError(400, path, "BAD_REQUEST");
  }
  if (typeof b.durationMin !== "number" || b.durationMin <= 0) throw new WorkforceApiError(400, path, "BAD_REQUEST");
  if (!b.patient) throw new WorkforceApiError(400, path, "BAD_REQUEST");

  mockWriteDisabled(path, b.clinicCode);
  mockNewPatientCheck(path, b);
  mockSlotTaken(path, b);

  const newApptId = `mock-appt-${djb2(`resched|${id}|${b.date}|${b.start}`).toString(16).padStart(8, "0")}`;
  // §D：reschedule → 舊 slot 釋放（id）+ 新 slot 計一筆
  forgetBooked(id);
  recordBooked({ apricotApptId: newApptId, clinicCode: b.clinicCode, providerApricotId: b.providerApricotId, date: b.date, start: b.start });
  log.info({ path, mock: true, status: 200 }, "workforce MOCK: booking rescheduled");
  return { v: 1, oldApptId: id, newApptId, dayRefreshed: !mockDayRefreshedOff(), syncedAt: new Date().toISOString() };
}

function mockDictionaries(params: Record<string, string>): unknown {
  const path = "/api/external/v1/dictionaries";
  const kind = params.kind;
  if (kind !== "VISIT_REASON" && kind !== "BOOKING_TYPE") throw new WorkforceApiError(400, path, "BAD_REQUEST");
  const data = readFixtureRecord<{ VISIT_REASON?: unknown[]; BOOKING_TYPE?: unknown[] }>(FIXTURE_DICTIONARIES_PATH);
  const items = data?.[kind];
  if (!Array.isArray(items)) throw new WorkforceApiError(500, path);
  log.info({ path, mock: true, status: 200 }, "workforce MOCK: dictionaries");
  return { v: 1, kind, items };
}

/** ★ cwi-followup-p0-20260915：companies mock — 決定性 fixture（sourceId 同 CWM dev seed 完全一樣，
 *  dev 實跑同 mock 兩條路徑落同一套 id）。CJK 名稱同兩 repo dev DB 逐字一樣。 */
function mockCompanies(): unknown {
  const path = "/api/external/v1/companies";
  log.info({ path, mock: true, status: 200 }, "workforce MOCK: companies");
  return {
    v: 1,
    companies: [
      { id: "fup0cmpa0000000000000000001", name: "菁薈", clinics: [{ id: "fup0tycl0000000000000000001", code: "TY", name: "TY 診所" }] },
      { id: "fup0cmpb0000000000000000002", name: "臻善", clinics: [{ id: "fup0ymtc0000000000000000002", code: "YMT", name: "YMT 診所" }, { id: "e2ereconcltw00000000001", code: "TW", name: "E2E Recon TW 診所" }, { id: "e2ereconclmf00000000002", code: "MF", name: "E2E Recon MF 診所" }] },
      { id: "fup0cmpc0000000000000000003", name: "匯樂", clinics: [{ id: "fup0tkwc0000000000000000003", code: "TKW", name: "TKW 診所" }, { id: "fup0ylcl0000000000000000004", code: "YL", name: "YL 診所" }, { id: "fup0wtcl0000000000000000005", code: "WTC", name: "WTC 診所" }] },
    ],
  };
}

type MockPatientData = {
  matches?: Record<string, unknown>[];
  appointments?: Record<string, unknown>[];
};

function mockPatientData(phoneHash: string): MockPatientData | null {
  const fixtureLookup = readFixtureRecord<{ byPhoneHash: Record<string, unknown> }>(FIXTURE_PATIENT_LOOKUP_PATH);
  const fixtureAppts = readFixtureRecord<{ byPhoneHash: Record<string, unknown> }>(FIXTURE_APPOINTMENTS_PATH);
  const runtime = readFixtureRecord<{ byPhoneHash: Record<string, MockPatientData> }>(MOCK_PATIENTS_FILE);
  const r = runtime?.byPhoneHash?.[phoneHash];
  if (!r) {
    const matches = fixtureLookup?.byPhoneHash?.[phoneHash];
    const appointments = fixtureAppts?.byPhoneHash?.[phoneHash];
    if (!matches && !appointments) return null;
    return { matches: (matches as Record<string, unknown>[]) ?? [], appointments: (appointments as Record<string, unknown>[]) ?? [] };
  }
  return r;
}

function mockPatientLookup(params: Record<string, string>): unknown {
  const path = "/api/external/v1/patient-lookup";
  const phoneHash = params.phoneHash ?? "";
  if (!/^[a-f0-9]{64}$/.test(phoneHash)) throw new WorkforceApiError(400, path, "BAD_REQUEST");
  const data = mockPatientData(phoneHash);
  log.info({ path, mock: true, status: 200 }, "workforce MOCK: patient-lookup");
  return { v: 1, matches: data?.matches ?? [] };
}

function mockAppointments(params: Record<string, string>): unknown {
  const path = "/api/external/v1/appointments";
  const phoneHash = params.phoneHash ?? "";
  const from = params.from ?? "";
  const to = params.to ?? "";
  if (!/^[a-f0-9]{64}$/.test(phoneHash) || !MOCK_DATE_RE.test(from) || !MOCK_DATE_RE.test(to)) {
    throw new WorkforceApiError(400, path, "BAD_REQUEST");
  }
  const data = mockPatientData(phoneHash);
  const all = (data?.appointments ?? []) as Record<string, unknown>[];
  const appointments = all.filter((a) => {
    const d = typeof a.date === "string" ? a.date : "";
    return d.length === 10 && d >= from && d <= to;
  });
  log.info({ path, mock: true, status: 200 }, "workforce MOCK: appointments");
  return { v: 1, syncedAt: new Date().toISOString(), stale: false, appointments };
}

// ── P2 病人記錄 mock（followup-v2 MD §2.6 — 數據對齊 CWM dev stub testdata/mock-apricot-clinical.ts）──
// cp-std-001  P0001 陳大文 +85291234567            9/14 TY st=4 + 9/22 st=0（未來）| STANDARD note | ttl800/os300
// cp-tpl-002  P0002 李美玲 +85291234567/+85261234567 9/14 TY st=4 | TEMPLATE storedTemplate | ttl1500/os1500
// cp-no-003   P0003 黃志強 +85291234567             9/14 TKW st=-3 爽約 | 無 note | 無 bill
// cp-late-004 P0004 張麗珍 +85261234567             9/14 TY st=1 | 無 note | ttl400/os400
// ── W e2e 擴展（決定性、零 PII — 欠款=0 chip 負測 + 未釘住配對 fixture）──
// cp-zs-005   P0005 周潔儀 +85223456789             9/13 TY st=4 | STANDARD note | ttl200/os0
// cp-pair-006 P0006 吳懿貞 +85234567890             9/14 TY st=4 | STANDARD note | ttl600/os1200

const MOCK_P2_CLINICS = new Set(["TY", "TKW", "MF", "TW", "YL", "YMT", "WTC"]);
export const MOCK_REFRESH_RESET_FLAG = ".dev/workforce-mock-refresh-reset";

type MockP2Visit = {
  visitId: string;
  visitDate: string;
  clinicCode: string;
  bookingStatus: number;
  visitReasonCodes: string[];
  providerCode: string | null;
  hasNote: boolean;
  noteKind: "STANDARD" | "TEMPLATE" | null;
  firstLine: string | null;
  /** #5 全文（mock 內部存；#4 回應物理上唔帶） */
  note?: NoteText;
};
type MockP2Appt = {
  apricotApptId: string;
  clinicCode: string;
  providerApricotId: string;
  providerName: string;
  date: string;
  start: string;
  end: string;
  bookingStatus: number;
  patientApricotId: string;
  patientCode: string;
  patientName: string;
  visitReasons: string[];
  remarks: string | null;
};
type MockP2Patient = {
  patientCode: string;
  /** E.164（mock 內部配對用；對外永遠只出 hash） */
  phones: string[];
  visits: MockP2Visit[];
  balance: { ttlAmt: number | null; osAmt: number | null };
  appointments: MockP2Appt[];
};

const MOCK_P2_PATIENTS: Record<string, MockP2Patient> = {
  "cp-std-001": {
    patientCode: "P0001",
    phones: ["+85291234567"],
    visits: [
      {
        visitId: "cv-std-001-1", visitDate: "2026-09-14", clinicCode: "TY", bookingStatus: 4,
        visitReasonCodes: ["FILLING", "SCALE"], providerCode: "DR1", hasNote: true, noteKind: "STANDARD",
        firstLine: "左上後牙咬痛三星期",
        note: { kind: "STANDARD", complaints: "左上後牙咬痛三星期", findings: "#26 深齲，探痛 (+)", diagnosis: "Deep caries #26", actions: "預留根管治療" },
      },
    ],
    balance: { ttlAmt: 800, osAmt: 300 },
    appointments: [
      { apricotApptId: "apt-std-1", clinicCode: "TY", providerApricotId: "DR1", providerName: "黃醫生", date: "2026-09-14", start: "10:00", end: "10:30", bookingStatus: 4, patientApricotId: "cp-std-001", patientCode: "P0001", patientName: "陳大文", visitReasons: ["FILLING", "SCALE"], remarks: null },
      { apricotApptId: "apt-std-2", clinicCode: "TY", providerApricotId: "DR1", providerName: "黃醫生", date: "2026-09-22", start: "10:00", end: "10:30", bookingStatus: 0, patientApricotId: "cp-std-001", patientCode: "P0001", patientName: "陳大文", visitReasons: ["RECALL"], remarks: null },
    ],
  },
  "cp-tpl-002": {
    patientCode: "P0002",
    phones: ["+85291234567", "+85261234567"],
    visits: [
      {
        visitId: "cv-tpl-002-1", visitDate: "2026-09-14", clinicCode: "TY", bookingStatus: 4,
        visitReasonCodes: ["FILLING"], providerCode: "DR2", hasNote: true, noteKind: "TEMPLATE",
        firstLine: "定期洗牙",
        note: {
          kind: "TEMPLATE", templateName: "CS Cleaning Template v3",
          blocks: [
            { label: "主訴", text: "定期洗牙" },
            { label: "口腔檢查", text: "牙石中度，齦緣輕微紅腫" },
            { label: "處置", text: "全口超音波洗牙" },
          ],
        },
      },
    ],
    balance: { ttlAmt: 1500, osAmt: 1500 },
    appointments: [
      { apricotApptId: "apt-tpl-1", clinicCode: "TY", providerApricotId: "DR2", providerName: "謝醫生", date: "2026-09-14", start: "11:00", end: "11:30", bookingStatus: 4, patientApricotId: "cp-tpl-002", patientCode: "P0002", patientName: "李美玲", visitReasons: ["FILLING"], remarks: null },
    ],
  },
  "cp-no-003": {
    patientCode: "P0003",
    phones: ["+85291234567"],
    visits: [
      {
        visitId: "cv-no-003-1", visitDate: "2026-09-14", clinicCode: "TKW", bookingStatus: -3,
        visitReasonCodes: ["CHECKUP"], providerCode: "DR3", hasNote: false, noteKind: null, firstLine: null,
      },
    ],
    balance: { ttlAmt: null, osAmt: null },
    appointments: [
      { apricotApptId: "apt-no-1", clinicCode: "TKW", providerApricotId: "DR3", providerName: "張醫生", date: "2026-09-14", start: "09:00", end: "09:30", bookingStatus: -3, patientApricotId: "cp-no-003", patientCode: "P0003", patientName: "黃志強", visitReasons: ["CHECKUP"], remarks: null },
    ],
  },
  "cp-late-004": {
    patientCode: "P0004",
    phones: ["+85261234567"],
    visits: [
      {
        visitId: "cv-late-004-1", visitDate: "2026-09-14", clinicCode: "TY", bookingStatus: 1,
        visitReasonCodes: ["EXTRACT"], providerCode: "DR1", hasNote: false, noteKind: null, firstLine: null,
      },
    ],
    balance: { ttlAmt: 400, osAmt: 400 },
    appointments: [
      { apricotApptId: "apt-late-1", clinicCode: "TY", providerApricotId: "DR1", providerName: "黃醫生", date: "2026-09-14", start: "15:00", end: "15:30", bookingStatus: 1, patientApricotId: "cp-late-004", patientCode: "P0004", patientName: "張麗珍", visitReasons: ["EXTRACT"], remarks: null },
    ],
  },
  "cp-zs-005": {
    patientCode: "P0005",
    phones: ["+85223456789"],
    visits: [
      {
        visitId: "cv-zs-005-1", visitDate: "2026-09-13", clinicCode: "TY", bookingStatus: 4,
        visitReasonCodes: ["SP"], providerCode: "DR1", hasNote: true, noteKind: "STANDARD",
        firstLine: "定期覆診",
        note: { kind: "STANDARD", complaints: "定期覆診", findings: "無異常", diagnosis: "常規檢查", actions: "三個月後覆診" },
      },
      { // 第二條過去 visit（3 月）— e2e「舊客」case（visitCount≥2）；零欠款保持（osAmt=0）
        visitId: "cv-zs-005-0", visitDate: "2026-03-15", clinicCode: "TY", bookingStatus: 4,
        visitReasonCodes: ["SP"], providerCode: "DR1", hasNote: false, noteKind: null, firstLine: null,
      },
    ],
    balance: { ttlAmt: 200, osAmt: 0 },
    // e2e 未-pin 配對 case：窗內一筆預約（對齊 09/13 visit）— #3 phoneHashes hasSome 配對源
    appointments: [
      { apricotApptId: "apt-zs-1", clinicCode: "TY", providerApricotId: "DR1", providerName: "黃醫生", date: "2026-09-13", start: "10:00", end: "10:30", bookingStatus: 1, patientApricotId: "cp-zs-005", patientCode: "P0005", patientName: "周潔儀", visitReasons: ["SP"], remarks: null },
    ],
  },
  "cp-pair-006": {
    patientCode: "P0006",
    phones: ["+85234567890"],
    visits: [
      {
        visitId: "cv-pair-006-1", visitDate: "2026-09-14", clinicCode: "TY", bookingStatus: 4,
        visitReasonCodes: ["FILLING"], providerCode: "DR2", hasNote: true, noteKind: "STANDARD",
        firstLine: "後牙敏感",
        note: { kind: "STANDARD", complaints: "後牙敏感", findings: "#36 頸部磨耗", diagnosis: "牙頸敏感", actions: "敏感劑塗佈" },
      },
    ],
    balance: { ttlAmt: 600, osAmt: 1200 },
    appointments: [
      { apricotApptId: "apt-pair-1", clinicCode: "TY", providerApricotId: "DR2", providerName: "謝醫生", date: "2026-09-14", start: "14:00", end: "14:30", bookingStatus: 4, patientApricotId: "cp-pair-006", patientCode: "P0006", patientName: "吳懿貞", visitReasons: ["FILLING"], remarks: null },
    ],
  },
};

/** e2e reset：touch 呢個檔 → 清空 refresh 限流/已刷新記憶（dev server 長駐，module 狀態跨 e2e run）。 */
function mockP2MaybeReset(): void {
  try {
    const fp = path.resolve(process.cwd(), MOCK_REFRESH_RESET_FLAG);
    if (existsSync(fp)) {
      mockP2Refreshed.clear();
      mockP2RefreshLast.clear();
      unlinkSync(fp);
    }
  } catch {
    /* best-effort */
  }
}

function mockP2Hashes(cpId: string): string[] {
  const p = MOCK_P2_PATIENTS[cpId];
  if (!p) return [];
  return p.phones.flatMap((raw) => phoneHashes(raw));
}

/** P2 syncedAt：now - offsetHours（default 5h = 灰「正常」態）；refresh 成功後該病人 → now（「剛剛更新」）。 */
const mockP2Refreshed = new Set<string>();
const mockP2RefreshLast = new Map<string, number>();
function mockP2SyncedAt(cpId?: string): string {
  mockP2MaybeReset();
  if (cpId && mockP2Refreshed.has(cpId)) return new Date().toISOString();
  const off = readFlag<{ offsetHours?: number }>(MOCK_SYNC_FLAG, (f) => typeof f.offsetHours === "number")?.offsetHours;
  const hours = typeof off === "number" && Number.isFinite(off) && off >= 0 ? off : 5;
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function mockP2Unknown(cpId: string, reqPath: string): never {
  throw new WorkforceApiError(404, reqPath, "PATIENT_NOT_FOUND");
}

function mockPatientVisits(cpId: string, params: Record<string, string>): unknown {
  const reqPath = "/api/external/v1/patients/{cpId}/visits";
  const p = MOCK_P2_PATIENTS[cpId];
  const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 100);
  let visits: unknown[];
  let patientCode = "PC";
  if (p) {
    // P2 靜態 fixture 無 rxCodes（pre-P4）— backfill 空陣列（真值：visit 藥物 code 本可空；PatientVisitsResponse 必填欄）
    visits = p.visits.map(({ note: _note, ...row }) => ({ ...row, rxCodes: (row as { rxCodes?: unknown }).rxCodes ?? [] }));
    patientCode = p.patientCode;
  } else {
    // ★ cwi-followup-p4 S6：臨床 mock fixture（.dev/workforce-mock-clinical.json）— 與 batch #1 同源（e2e C/D/E + 藥物 tab rxCodes）
    const f = readClinical();
    const rows = (f.visits ?? []).filter((v) => v.patientApricotId === cpId);
    visits = rows.map((v) => {
      const { patientApricotId: _a, phoneHashes: _h, quotedItems: _q, billTtlAmt: _b, billOsAmt: _o, ...rest } = v;
      // 必填欄 backfill（真值本可空）— 防 fixture 漏欄 zod 炸
      return { ...rest, rxCodes: rest.rxCodes ?? [], noteKind: rest.noteKind ?? null, firstLine: rest.firstLine ?? null };
    });
    if (rows[0]?.patientCode != null) patientCode = String(rows[0].patientCode);
    if (!visits.length) {
      mockP2Unknown(cpId, reqPath);
      throw new WorkforceApiError(404, reqPath, "NOT_FOUND");
    }
  }
  const out = visits.slice(0, limit);
  if (!out.length) throw new WorkforceApiError(404, reqPath, "NOT_FOUND");
  log.info({ path: reqPath, mock: true, status: 200 }, "workforce MOCK: patient visits");
  return { v: 1, patientCode, visits: out };
}

function mockVisitNote(cpId: string, visitId: string, reqPath: string): unknown {
  const p = MOCK_P2_PATIENTS[cpId];
  if (!p) throw new WorkforceApiError(404, reqPath, "VISIT_NOT_FOUND");
  const v = p.visits.find((x) => x.visitId === visitId);
  if (!v) throw new WorkforceApiError(404, reqPath, "VISIT_NOT_FOUND");
  if (!v.hasNote || !v.note) throw new WorkforceApiError(404, reqPath, "NOTE_NOT_FOUND");
  log.info({ path: reqPath, mock: true, status: 200 }, "workforce MOCK: visit note（audit = CWM 側 EXTERNAL_NOTE_VIEWED）");
  return { v: 1, visitId: v.visitId, patientApricotId: cpId, visitDate: v.visitDate, noteKind: v.noteKind, note: v.note };
}

function mockPatientBalance(cpId: string): unknown {
  const reqPath = "/api/external/v1/patients/{cpId}/balance";
  // ★ P3：動態 balance 覆蓋（e2e 寫入 — osAmt 600/0 等場景）
  const fu = readMockFollowup();
  const fuBal = fu?.balances?.[cpId];
  if (fuBal) {
    log.info({ path: reqPath, mock: true, status: 200, dynamic: true }, "workforce MOCK: patient balance（followup 動態）");
    return {
      v: 1,
      patientCode: `P3-${cpId}`,
      asOf: new Date().toISOString().slice(0, 10),
      balance: { ttlAmt: fuBal.ttlAmt ?? fuBal.osAmt ?? null, osAmt: fuBal.osAmt },
      syncedAt: mockP2SyncedAt(cpId),
    };
  }
  const p = MOCK_P2_PATIENTS[cpId];
  if (!p) mockP2Unknown(cpId, reqPath);
  log.info({ path: reqPath, mock: true, status: 200 }, "workforce MOCK: patient balance");
  return {
    v: 1,
    patientCode: p.patientCode,
    asOf: p.visits[0]?.visitDate ?? "",
    balance: p.balance,
    syncedAt: mockP2SyncedAt(cpId),
  };
}

function mockClinicAppointments(params: Record<string, string>): unknown {
  const reqPath = "/api/external/v1/appointments";
  const clinicCode = (params.clinicCode ?? "").trim();
  const from = params.from ?? "";
  const to = params.to ?? "";
  if (!clinicCode || !MOCK_DATE_RE.test(from) || !MOCK_DATE_RE.test(to)) throw new WorkforceApiError(400, reqPath, "BAD_REQUEST");
  const diffDays = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!Number.isFinite(diffDays) || diffDays < 0 || diffDays > 37) throw new WorkforceApiError(400, reqPath, "BAD_REQUEST");
  if (!MOCK_P2_CLINICS.has(clinicCode)) throw new WorkforceApiError(404, reqPath, "NOT_FOUND");
  const appts: (MockP2Appt & { phoneHashes: string[] })[] = [];
  for (const [cpId, p] of Object.entries(MOCK_P2_PATIENTS)) {
    for (const a of p.appointments) {
      if (a.clinicCode !== clinicCode || a.date < from || a.date > to) continue;
      appts.push({ ...a, phoneHashes: mockP2Hashes(cpId) });
    }
  }
  appts.sort((x, y) => (x.date === y.date ? x.start.localeCompare(y.start) : x.date.localeCompare(y.date)));
  // ★ P3：合併動態 follow-up fixture（e2e 寫入相對日期 — 明日 0/102、前日 -3）
  const fu = readMockFollowup();
  if (fu?.appointments) {
    for (const a of fu.appointments) {
      if (a.clinicCode !== clinicCode || a.date < from || a.date > to) continue;
      appts.push({
        apricotApptId: a.apricotApptId,
        clinicCode: a.clinicCode,
        providerApricotId: a.providerApricotId,
        providerName: a.providerName,
        date: a.date,
        start: a.start,
        end: a.end,
        bookingStatus: a.bookingStatus,
        patientApricotId: a.patientApricotId,
        patientCode: `P3-${a.patientApricotId}`,
        patientName: `P3 Patient ${a.patientApricotId}`,
        visitReasons: [],
        remarks: null,
        phoneHashes: a.phoneHashes ?? [],
      });
    }
    appts.sort((x, y) => (x.date === y.date ? x.start.localeCompare(y.start) : x.date.localeCompare(y.date)));
  }
  log.info({ path: reqPath, mock: true, status: 200 }, "workforce MOCK: clinic appointments");
  return { v: 1, syncedAt: mockP2SyncedAt(), stale: false, appointments: appts };
}

/** P3 動態 follow-up fixture 型（.dev/workforce-mock-followup.json）。 */
export interface MockFollowupFixture {
  appointments?: {
    clinicCode: string;
    date: string;
    start: string;
    end: string;
    providerApricotId: string;
    providerName: string;
    patientApricotId: string;
    bookingStatus: number;
    apricotApptId: string;
    phoneHashes?: string[];
  }[];
  balances?: Record<string, { osAmt: number | null; ttlAmt?: number | null }>;
}

/** 讀 P3 動態 follow-up fixture（容錯：檔不存在/損壞 → null）。 */
function readMockFollowup(): MockFollowupFixture | null {
  try {
    const raw = readFileSync(MOCK_FOLLOWUP_FLAG, "utf8");
    const obj = JSON.parse(raw) as MockFollowupFixture;
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

function mockPatientRefresh(cpId: string, reqPath: string): unknown {
  mockP2MaybeReset();
  const p = MOCK_P2_PATIENTS[cpId];
  if (!p) mockP2Unknown(cpId, reqPath);
  const flag = readFlag<{ mode?: string; retryAfterSec?: number }>(MOCK_REFRESH_FLAG, () => true);
  const mode = flag?.mode ?? "ok";
  const now = Date.now();
  const last = mockP2RefreshLast.get(cpId) ?? 0;
  const bucketLeft = Math.max(1, Math.ceil((60_000 - (now - last)) / 1000));
  if (mode === "rate" || (mode === "ok" && last > 0 && now - last < 60_000)) {
    log.info({ path: reqPath, mock: true, status: 429 }, "workforce MOCK: refresh rate limited");
    throw new WorkforceApiError(429, reqPath, "RATE_LIMITED", Math.max(bucketLeft, flag?.retryAfterSec ?? 37));
  }
  if (mode === "fail") {
    log.info({ path: reqPath, mock: true, status: 503 }, "workforce MOCK: refresh APRICOT_UNAVAILABLE");
    throw new WorkforceApiError(503, reqPath, "APRICOT_UNAVAILABLE");
  }
  mockP2Refreshed.add(cpId);
  mockP2RefreshLast.set(cpId, now);
  log.info({ path: reqPath, mock: true, status: 200 }, "workforce MOCK: patient refresh ok");
  return { v: 1, syncedAt: new Date().toISOString(), visits: p.visits.length, balance: p.balance };
}

// ── bookable-slots mock（providerslot-20260830 T3 — 決定性；shape = contract）──

/** .dev/workforce-mock-held.json → HeldItem[]（截圖/e2e 控制；缺檔 = 空）。 */
function readStaticHolds(): HeldItem[] {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(process.cwd(), MOCK_HELD_FLAG), "utf8"));
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter(
      (h) =>
        h &&
        typeof h.holdId === "string" &&
        typeof h.date === "string" &&
        typeof h.startMin === "number" &&
        typeof h.endMin === "number" &&
        typeof h.providerName === "string" &&
        (h.status === "HELD" || h.status === "IN_APRICOT")
    );
  } catch {
    return [];
  }
}

/** T4：claim store 條目 → HeldItem[]（HELD/IN_APRICOT；零 PII — 無病人欄）。 */
function claimStoreHolds(): HeldItem[] {
  const now = Date.now();
  return readClaimStore().map((e) => ({
    holdId: e.holdId,
    date: e.date,
    startMin: e.startMin,
    endMin: e.endMin,
    providerId: e.providerId,
    providerName: e.providerName,
    status: e.status,
    source: "whatsapp_flow",
    createdAt: e.createdAt,
    ageHours: Math.max(0, (now - Date.parse(e.createdAt)) / 3600e3),
    appointmentPast: false,
  }));
}

/** held mock = 靜態控制檔 + T4 claim store（holdId 去重）。 */
function readMockHolds(): HeldItem[] {
  const all = [...readStaticHolds(), ...claimStoreHolds()];
  const seen = new Set<string>();
  return all.filter((h) => (seen.has(h.holdId) ? false : (seen.add(h.holdId), true)));
}

/** 決定性 mock bookable-slots：兩醫生（mock-pract-*）、09:00–13:00 offerable、
 *  休診日 djb2(clinic+date)%7===3、seatsFree 1..capacity（djb2 派生）。
 *  T4：扣去 claim hold 已佔嘅 seat（MD §4：HELD 立即由可約計算扣除；seatsFree 歸 0 → 唔出）。 */

const MOCK_CAPACITY = 3;
const MOCK_START_MIN = 9 * 60;
const MOCK_END_MIN = 13 * 60;
const MOCK_PROVIDER_NAMES = ["mock 陳醫師", "mock 李醫師"];

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** T4：mock claim hold store（file = 跨 request 持久；零 PII；e2e 完清檔）。 */
interface MockClaimEntry {
  holdId: string;
  flowToken: string;
  slotKey: string;
  clinicCode: string;
  providerId: string;
  providerName: string;
  date: string;
  startMin: number;
  endMin: number;
  status: "HELD" | "IN_APRICOT";
  createdAt: string;
}

function readClaimStore(): MockClaimEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(process.cwd(), MOCK_CLAIMS_FILE), "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter(
          (e) =>
            e &&
            typeof e.holdId === "string" &&
            typeof e.flowToken === "string" &&
            typeof e.slotKey === "string" &&
            typeof e.startMin === "number" &&
            (e.status === "HELD" || e.status === "IN_APRICOT")
        )
      : [];
  } catch {
    return [];
  }
}

function writeClaimStore(entries: MockClaimEntry[]): void {
  try {
    writeFileSync(path.resolve(process.cwd(), MOCK_CLAIMS_FILE), JSON.stringify(entries, null, 1));
  } catch {
    /* best-effort — 寫唔到 = hold 丟（e2e 斷言會 red） */
  }
}

/** commit（T4）：store 入該 hold → HELD→IN_APRICOT（唔喺 store = 靜態 fixture → no-op）。 */
function markClaimCommitted(holdId: string): void {
  const store = readClaimStore();
  const hit = store.find((e) => e.holdId === holdId);
  if (hit && hit.status === "HELD") {
    hit.status = "IN_APRICOT";
    writeClaimStore(store);
  }
}

/** release（★ cwi-final S5-11 F4）：store 移除該 hold（位放開 — held mock / bookable-slots mock 重新 offer）。
 *  冪等：唔喺 store → no-op（對齊真端點「已 RELEASED → 200 同狀」）。 */
function markClaimReleased(holdId: string): void {
  const store = readClaimStore();
  const next = store.filter((e) => e.holdId !== holdId);
  if (next.length !== store.length) writeClaimStore(next);
}

/** 該 slot 活躍 hold 數（HELD/IN_APRICOT 都佔位 — 真 T1：holds 入 concurrency 重算）。 */
function holdCountAt(clinicCode: string, providerId: string, date: string, startMin: number): number {
  return readClaimStore().filter(
    (e) => e.clinicCode === clinicCode && e.providerId === providerId && e.date === date && e.startMin === startMin
  ).length;
}

/** T150：mock 額外醫生數（flag 檔 — 缺檔 = 0；只影響 mock base day 嘅 provider 數）。 */
function readExtraProviders(): { clinicCode: string; extra: number }[] {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(process.cwd(), MOCK_EXTRA_PROVIDERS_FLAG), "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter((e) => e && typeof e.clinicCode === "string" && typeof e.extra === "number" && e.extra > 0)
      : [];
  } catch {
    return [];
  }
}

/** 該日 base slots（hash seatsFree、未扣 hold）— bookable-slots mock 同 claim mock 共用。 */
function mockBaseDay(clinicCode: string, date: string): { closed: boolean; slots: BookableSlot[] } {
  const closed = djb2(`${clinicCode}|${date}`) % 7 === 3;
  const slots: BookableSlot[] = [];
  if (!closed) {
    const extras = readExtraProviders().find((e) => e.clinicCode === clinicCode)?.extra ?? 0;
    const totalProviders = MOCK_PROVIDER_NAMES.length + extras;
    for (let p = 0; p < totalProviders; p++) {
      const providerId = `mock-pract-${clinicCode}-${p}`;
      const providerName = p < MOCK_PROVIDER_NAMES.length ? MOCK_PROVIDER_NAMES[p] : `mock 醫生${p + 1}`;
      for (let s = MOCK_START_MIN; s < MOCK_END_MIN; s += 30) {
        const seatsFree = 1 + (djb2(`${clinicCode}|${date}|${s}|${p}`) % MOCK_CAPACITY);
        slots.push({
          start: minToHHmm(s),
          end: minToHHmm(s + 30),
          providerId,
          providerName,
          seatsFree,
          slotKey: `mock|${clinicCode}|${date}|${minToHHmm(s)}|${providerId}`,
        });
      }
    }
  }
  slots.sort((a, b) => a.start.localeCompare(b.start) || a.providerName.localeCompare(b.providerName));
  return { closed, slots };
}

/** T4：effective offerable = base − 活躍 holds（seatsFree 歸 0 → 唔出，MD §4）。
 *  G-4（B7）：mock 對齊新 F 契約 — 一併回 remainingCapacity（F2：剩餘 = seatsFree）。 */
function mockDaySlots(clinicCode: string, date: string): BookableSlot[] {
  const { slots } = mockBaseDay(clinicCode, date);
  return slots
    .map((s): BookableSlot | null => {
      const eff = s.seatsFree - holdCountAt(clinicCode, s.providerId, date, hhmmToMin(s.start));
      return eff > 0 ? { ...s, seatsFree: eff, remainingCapacity: eff } : null;
    })
    .filter((s): s is BookableSlot => s !== null);
}

function mockBookableSlots(params: Record<string, string>): unknown {
  const reqPath = "/api/external/v1/bookable-slots";
  const clinicCode = params.clinicCode ?? "";
  const from = params.from ?? "";
  const to = params.to ?? "";
  if (!clinicCode || !MOCK_DATE_RE.test(from) || !MOCK_DATE_RE.test(to)) {
    throw new WorkforceApiError(400, reqPath, "BAD_REQUEST");
  }
  const days: BookableDay[] = [];
  let dayGuard = 0;
  for (let d = from; d <= to; d = addDaysStr(d, 1)) {
    // 防禦：日期循環不終止 = 上層 bug（2026-08-30 實錘：+08:00 解析令 d 永不前進 → 8GB OOM）— fail fast 唔好死循環
    if (++dayGuard > 40) throw new WorkforceApiError(500, reqPath, "MOCK_DATE_LOOP");
    const { closed } = mockBaseDay(clinicCode, d);
    const slots = mockDaySlots(clinicCode, d);
    days.push({ date: d, closed, offerableCount: slots.length, slots });
  }
  log.info({ reqPath, clinic: clinicCode, days: days.length, mock: true, status: 200 }, "workforce MOCK: bookable-slots");
  return {
    v: 1,
    unitMin: 30,
    capacityPerProvider: MOCK_CAPACITY,
    leadTimeMin: 60,
    generatedAt: new Date().toISOString(),
    days,
  };
}

// ── T4：mock claim（決定性 — 冪等 by flowToken + 409 slot_taken；零 PII 落 store）──

const MOCK_SLOTKEY_RE = /^mock\|([^|]+)\|(\d{4}-\d{2}-\d{2})\|(\d{2}:\d{2})\|([^|]+)$/;
const MOCK_CLAIM_SOURCES = new Set(["whatsapp_flow", "staff"]);

function mockClaim(bodyIn: unknown): unknown {
  const reqPath = "/api/external/v1/bookable-slots/claim";
  const b = (bodyIn ?? {}) as Record<string, unknown>;
  if (b.v !== 1 || typeof b.slotKey !== "string" || b.slotKey.length < 8 || b.slotKey.length > 512) {
    throw new WorkforceApiError(400, reqPath, "BAD_REQUEST");
  }
  const p = b.patient as { waId?: unknown } | null | undefined;
  if (typeof p !== "object" || p === null || Array.isArray(p) || typeof p.waId !== "string") {
    throw new WorkforceApiError(400, reqPath, "BAD_REQUEST");
  }
  const waId = p.waId.trim();
  if (waId.length < 5 || waId.length > 20) throw new WorkforceApiError(400, reqPath, "BAD_REQUEST");
  if (typeof b.source !== "string" || !MOCK_CLAIM_SOURCES.has(b.source)) throw new WorkforceApiError(400, reqPath, "BAD_REQUEST");
  const flowToken = typeof b.flowToken === "string" ? b.flowToken.trim() : "";
  if (flowToken.length < 8 || flowToken.length > 128) throw new WorkforceApiError(400, reqPath, "BAD_REQUEST");

  const m = MOCK_SLOTKEY_RE.exec(b.slotKey);
  if (!m) throw new WorkforceApiError(400, reqPath, "BAD_REQUEST");
  const [, clinicCode, date, startHHmm, providerId] = m;
  const startMin = hhmmToMin(startHHmm);
  const endMin = startMin + 30;
  const base = mockBaseDay(clinicCode, date);
  const baseSlot = base.slots.find((s) => s.providerId === providerId && s.start === startHHmm);
  // 休診日 / 該醫生冇開呢個時 = 唔可 claim（同真 T1 唔 offerable → slot_taken）
  if (!baseSlot) throw new WorkforceApiError(409, reqPath); // 同真 T1：slot_taken 409 body 無 code 欄

  const store = readClaimStore();

  // 1) 冪等：同 flowToken（真 T1：flowToken @unique — 同 token 同 slot → 同 hold；唔同 slot → FLOW_TOKEN_REUSED）
  const same = store.find((e) => e.flowToken === flowToken);
  if (same) {
    if (same.slotKey === b.slotKey) {
      log.info({ reqPath, mock: true, status: 201 }, "workforce MOCK: claim idempotent replay（同 token 同 slot）");
      return mockClaimOk(same);
    }
    log.info({ reqPath, mock: true, status: 409 }, "workforce MOCK: claim FLOW_TOKEN_REUSED");
    throw new WorkforceApiError(409, reqPath, "FLOW_TOKEN_REUSED");
  }

  // 2) slot  contention：base seatsFree − 活躍 holds ≥ 1 先收（真 T1：交易內重算 offerable，concurrency < capacity）
  if (baseSlot.seatsFree - holdCountAt(clinicCode, providerId, date, startMin) < 1) {
    log.info({ reqPath, mock: true, status: 409 }, "workforce MOCK: claim SLOT_TAKEN");
    throw new WorkforceApiError(409, reqPath); // 同真 T1：slot_taken 409 body 無 code 欄
  }

  // 3) 落 hold（holdId = slotKey djb2 決定性 — 一 slot 一 hold，重放穩定；🔴 零病人資料入 store）
  const entry: MockClaimEntry = {
    holdId: `mock-hold-${djb2(b.slotKey).toString(16).padStart(8, "0")}`,
    flowToken,
    slotKey: b.slotKey,
    clinicCode,
    providerId,
    providerName: baseSlot.providerName,
    date,
    startMin,
    endMin,
    status: "HELD",
    createdAt: new Date().toISOString(),
  };
  writeClaimStore([...store, entry]);
  log.info({ reqPath, clinic: clinicCode, date, start: startHHmm, provider: providerId, mock: true, status: 201 }, "workforce MOCK: claim created");
  return mockClaimOk(entry);
}

/** 201 response（同真 T1 shape — 🔴 零病人資料）。 */
function mockClaimOk(e: MockClaimEntry): unknown {
  return {
    v: 1,
    holdId: e.holdId,
    start: minToHHmm(e.startMin),
    end: minToHHmm(e.endMin),
    date: e.date,
    providerName: e.providerName,
    expiresAt: null,
  };
}

function addDaysStr(dateStr: string, n: number): string {
  // 純日曆日運算：按 UTC 午夜解（+08:00 解會令 getUTCDate 跨日界 → +1 日 = 同一日 → 無限循環；
  // 同 slots-board.tsx addDays 同一修正 — 2026-08-30 T3 visual 驗證實錘 8GB OOM）
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function readSlotTakenFlags(): { clinicCode: string; providerApricotId: string; date: string; start: string }[] {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(process.cwd(), MOCK_SLOT_TAKEN_FLAG), "utf8"));
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter(
      (f) =>
        f &&
        typeof f.clinicCode === "string" &&
        typeof f.providerApricotId === "string" &&
        typeof f.date === "string" &&
        typeof f.start === "string"
    );
  } catch {
    return [];
  }
}

function readFixtureRecord<S>(abs: string): S | null {
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as S;
  } catch {
    log.warn({ fixture: path.basename(abs) }, "workforce MOCK: fixture missing → empty");
    return null;
  }
}

/** 決定性 mock availability（shape = contract；rules 沿用舊 mock hash 規則）。
 *  providers 來源：本 DB Provider 名錄（mock 期 = seed 派生）；DB 唔到 → fixture 內建 provider。 */
async function mockAvailability(params: Record<string, string>): Promise<unknown> {
  const clinicCode = params.clinicCode ?? "";
  const from = params.from ?? "";
  const to = params.to ?? "";
  const providerFilter = params.providerApricotId ?? "";
  const stale = process.env.WORKFORCE_MOCK_STALE === "1" || !!readFlag<{ clinicCode?: string }>(MOCK_STALE_FLAG, (f) => f.clinicCode === clinicCode);
  const now = new Date();
  const syncedAt = stale ? new Date(now.getTime() - 45 * 60 * 1000).toISOString() : now.toISOString();

  // providers：DB 名錄（seed：mock-pract-<clinic>-<n>）— mock 期 DB 必在；DB 錯 → fixture fallback
  let providers: { apricotId: string; name: string }[] = [];
  try {
    const { default: prisma } = await import("@/lib/prisma");
    const clinic = await prisma.clinic.findUnique({ where: { code: clinicCode }, select: { id: true } });
    if (clinic) {
      const rows = await prisma.providerClinic.findMany({
        where: { clinicId: clinic.id, provider: { active: true, apricotId: { not: null } } },
        include: { provider: true },
        orderBy: { provider: { name: "asc" } },
      });
      providers = rows.map((r) => ({ apricotId: r.provider.apricotId!, name: r.provider.name }));
    }
  } catch {
    /* DB 唔到 → fixture fallback（下方） */
  }
  if (providers.length === 0) {
    try {
      const fx = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
      const p = fx?.days?.[0]?.providers?.[0];
      if (p) providers = [{ apricotId: String(p.providerApricotId), name: String(p.providerName) }];
    } catch {
      /* fixture 都唔到 → 空 providers（= 該店無空檔，決定性） */
    }
  }
  if (providerFilter) providers = providers.filter((p) => p.apricotId === providerFilter);

  // 決定性 slot 規則（沿用舊 mock）：
  // - 閉诊日：djb2(clinic|provider|date) % 7 === 0 → 該日 0 slot
  // - 滿位：  djb2(clinic|provider|date|start) % 4 === 0 或 fill flag → bookedCount=1
  // - 開診時段：10:00-13:00 + 14:00-17:00（30 分鐘 slot）
  const dates: string[] = [];
  {
    let d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`).getTime();
    while (d.getTime() <= end) {
      dates.push(d.toISOString().slice(0, 10));
      d = new Date(d.getTime() + 86400000);
    }
  }
  const fillFlags = readFillFlags().filter((f) => f.clinicCode === clinicCode);
  const openSchs = [
    { startTime: "10:00", endTime: "13:00" },
    { startTime: "14:00", endTime: "17:00" },
  ];

  const days = dates.map((date) => {
    const dayProviders = providers
      .map((p) => {
        if (djb2(`${clinicCode}|${p.apricotId}|${date}`) % 7 === 0) return null; // 閉诊日
        const slots: { start: string; end: string; isOpen: boolean; bookedCount: number; remainingCapacity?: number }[] = [];
        for (const sch of openSchs) {
          let t = sch.startTime;
          while (t < sch.endTime) {
            const t2 = addMin(t, 30);
            const flag = fillFlags.find(
              (f) => f.providerApricotId === p.apricotId && f.date === date && f.startTime === t
            );
            // 舊 flag（無 remainingCapacity）= 標滿（bookedCount=1）行為不變；
            // §D：flag 帶 remainingCapacity = 容量治理（唔改 bookedCount — 純 rc 測試）
            const filled = djb2(`${clinicCode}|${p.apricotId}|${date}|${t}`) % 4 === 0 || (flag !== undefined && flag.remainingCapacity == null);
            // §D：flag 帶 base 容量 → 回 remainingCapacity = max(0, base − 已 mock book 數)（遞減測試）；
            // 無 flag / 無 remainingCapacity 欄 = 缺欄（workforce 未上 capacity）→ 唔回欄（fallback=1 迴歸）
            let remainingCapacity: number | undefined;
            if (flag?.remainingCapacity != null) {
              remainingCapacity = Math.max(0, flag.remainingCapacity - bookedCountAt(clinicCode, p.apricotId, date, t));
            }
            slots.push({
              start: t,
              end: t2,
              isOpen: true,
              bookedCount: filled ? 1 : 0,
              ...(remainingCapacity !== undefined ? { remainingCapacity } : {}),
            });
            t = t2;
          }
        }
        return { providerApricotId: p.apricotId, providerName: p.name, slots };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { date, providers: dayProviders };
  });

  log.debug({ clinic: clinicCode, days: days.length, stale, mock: true }, "workforce MOCK: availability generated");
  return { v: 1, clinicCode, syncedAt, stale, days };
}

function addMin(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
