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
 * zod parse = contract 執行點：response 過唔到 schema = 當 API fail（§3 降級鏈接住）。
 * z.object 預設 strip 唔識欄位 → 病人欄位（medicalHistory 等）物理上入唔到下游。
 *
 * ★ 鐵律：
 * - log 只 path + status（零 body）— WORKFORCE_API_KEY 永遠唔入 log；error 分類 code 只入
 *   WorkforceApiError.code（供路由分支），一樣唔入 log
 * - 3s timeout（同機 call，已係天荒地老）
 * - WORKFORCE_MOCK=1 → mock（§4：fixture 決定性，E2E/開發用）
 *
 * env：WORKFORCE_API_URL / WORKFORCE_API_KEY / WORKFORCE_MOCK
 *      BOOKING_DEFAULT_VISIT_REASON_CODE（預設 visit reason；空 = 無預設，UI/staff 必揀）
 */
import { z } from "zod";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import log from "@/lib/log";

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

const LastVisitSchema = z.object({ date: z.string(), providerName: z.string(), visitReasons: z.array(z.string()) });
export const PatientLookupResponse = z.object({
  v: z.literal(1),
  matches: z.array(z.object({
    patientApricotId: z.string(),
    patientCode: z.string(),
    patientName: z.string(),
    lastVisit: LastVisitSchema.nullable(),
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

// ── 錯誤類型（log 只 path+status）────────────────────────────────────────

export class WorkforceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    /** workforce 錯誤碼（SLOT_TAKEN / NEW_PATIENT_DISABLED / WRITE_DISABLED / …）— 只供路由分支，唔入 log */
    public readonly code?: string,
  ) {
    super(`workforce API ${status} ${path}`);
    this.name = "WorkforceApiError";
  }
}

const WORKFORCE_TIMEOUT_MS = 3000;

// ── HTTP（real mode）─────────────────────────────────────────────────────

/**
 * real mode fetch：log 只 path + status（零 body）。
 * 4xx/5xx 時只 parse error body 嘅 `code` 欄（分類標籤，供路由分支）— body 本身唔入 log、唔洩傳。
 */
async function wfFetch(method: "GET" | "POST" | "PUT", path: string, params: Record<string, string>, body?: unknown): Promise<unknown> {
  const url = new URL(path, process.env.WORKFORCE_API_URL); // http://127.0.0.1:<port>
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "x-api-key": process.env.WORKFORCE_API_KEY ?? "",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(WORKFORCE_TIMEOUT_MS),
    });
  } catch (err) {
    // timeout / DNS / 拒接 — log 只 path（零 body；err message 唔會含 key）
    log.warn({ path, err: err instanceof Error ? err.name : "network" }, "workforce: fetch failed");
    throw new WorkforceApiError(0, path);
  }
  if (!res.ok) {
    // ★ log 只 path + status（零 body — 401 都唔洩 response 內容）
    let code: string | undefined;
    try {
      const j = (await res.json()) as { code?: unknown };
      if (j && typeof j.code === "string") code = j.code; // 只取分類標籤
    } catch {
      /* non-JSON error body（reverse proxy HTML 等）— path+status 已夠 */
    }
    log.warn({ path, status: res.status }, "workforce: non-2xx");
    throw new WorkforceApiError(res.status, path, code);
  }
  log.debug({ path, status: res.status }, "workforce: fetch ok");
  return res.json();
}

async function wfGet(path: string, params: Record<string, string>) {
  if (process.env.WORKFORCE_MOCK === "1") return mockFixture(path, params); // §4
  return wfFetch("GET", path, params);
}

async function wfSend(method: "POST" | "PUT", path: string, params: Record<string, string>, body?: unknown) {
  if (process.env.WORKFORCE_MOCK === "1") return mockFixture(path, params, method, body); // §4
  return wfFetch(method, path, params, body);
}

/** test-only 出入口：mock 模式下直接打 workforce 端驗證（e.g. status 白名單）— 本 repo 測試用 */
export const wfSendForTest = wfSend;

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
  const raw = await wfSend("POST", "/api/external/v1/bookings", {}, body);
  return BookingCreateResponse.parse(raw);
}

/** 改狀態（白名單 102 / -7 — 其他 workforce 400） */
export async function updateBookingStatus(
  apricotApptId: string,
  status: 102 | -7,
  p: { clinicCode: string; date: string }
): Promise<BookingStatusResult> {
  const raw = await wfSend(
    "PUT",
    `/api/external/v1/bookings/${encodeURIComponent(apricotApptId)}/status`,
    { status: String(status), date: p.date, clinicCode: p.clinicCode }
  );
  return BookingStatusResponse.parse(raw);
}

/** 刪 appointment（rollback 路徑 — 撤銷代落單） */
export async function removeBooking(
  apricotApptId: string,
  p: { clinicCode: string; date: string }
): Promise<BookingRemoveResult> {
  const raw = await wfSend(
    "PUT",
    `/api/external/v1/bookings/${encodeURIComponent(apricotApptId)}/remove`,
    { date: p.date, clinicCode: p.clinicCode }
  );
  return BookingRemoveResponse.parse(raw);
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
  }
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
  const raw = await wfSend("POST", `/api/external/v1/bookings/${encodeURIComponent(apricotApptId)}/reschedule`, {}, body);
  return BookingRescheduleResponse.parse(raw);
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
export const MOCK_PATIENTS_FILE = ".dev/workforce-mock-patients.json";
// §D（cwi-r2）：mock booking store（create 後 capacity 遞減 / remove 還原）— 決定性，e2e cleanup 清檔
export const MOCK_BOOKED_FILE = ".dev/workforce-mock-booked.json";
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

function mockFixture(path: string, params: Record<string, string>, method?: "POST" | "PUT", body?: unknown): unknown {
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

function mockFixtureImpl(path: string, params: Record<string, string>, method?: "POST" | "PUT", body?: unknown): unknown {
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

  if (path === "/api/external/v1/bookings" && method === "POST") {
    return mockCreateBooking(body);
  }

  if (path === "/api/external/v1/dictionaries") {
    return mockDictionaries(params);
  }

  if (path === "/api/external/v1/patient-lookup") {
    return mockPatientLookup(params);
  }

  if (path === "/api/external/v1/appointments") {
    return mockAppointments(params);
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

// ── mock 寫入端點 helper（決定性；log 同 real mode 一樣只 path+status）──

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
    dayRefreshed: true,
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
  return { v: 1, bookingStatus: status, dayRefreshed: true, syncedAt: new Date().toISOString() };
}

function mockBookingRemove(id: string, params: Record<string, string>): unknown {
  const path = `/api/external/v1/bookings/${encodeURIComponent(id)}/remove`;
  if (!params.date || !params.clinicCode) throw new WorkforceApiError(400, path, "BAD_REQUEST");
  mockWriteDisabled(path, params.clinicCode);
  forgetBooked(id); // §D：remove → capacity 還原
  log.info({ path, mock: true, status: 200 }, "workforce MOCK: booking removed");
  return { v: 1, removed: true, dayRefreshed: true, syncedAt: new Date().toISOString() };
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
  return { v: 1, oldApptId: id, newApptId, dayRefreshed: true, syncedAt: new Date().toISOString() };
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
