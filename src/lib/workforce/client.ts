/**
 * clinic-workforce External API client（switch MD §2 — wa-inbox 對 workforce 嘅唯一 HTTP 通道）
 *
 * 契約（兩份一字一樣 — 改契約要兩邊同步）：
 *   GET {WORKFORCE_API_URL}/api/external/v1/availability?clinicCode=&from=&to=[&providerApricotId=]
 *   GET {WORKFORCE_API_URL}/api/external/v1/duty-roster?clinicCode=&date=
 *   Header: x-api-key（gen-external-key 出嗰條）
 *
 * zod parse = contract 執行點：response 過唔到 schema = 當 API fail（§3 降級鏈接住）。
 * z.object 預設 strip 唔識欄位 → 病人欄位（medicalHistory 等）物理上入唔到下游。
 *
 * ★ 鐵律：
 * - log 只 path + status（零 body、零 query 值以外嘅敏感位）— WORKFORCE_API_KEY 永遠唔入 log
 * - 3s timeout（同機 call，已係天荒地老）
 * - WORKFORCE_MOCK=1 → mock（§4：fixture 決定性，E2E/開發用）
 *
 * env：WORKFORCE_API_URL / WORKFORCE_API_KEY / WORKFORCE_MOCK
 */
import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import log from "@/lib/log";

// ── zod contract（§2 原樣）───────────────────────────────────────────────

const SlotSchema = z.object({ start: z.string(), end: z.string(), isOpen: z.boolean(), bookedCount: z.number().int() });
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
  staffName: z.string(), role: z.string(), shiftStart: z.string(), shiftEnd: z.string() })) });
export type WorkforceDuty = z.infer<typeof DutySchema>;

// ── 錯誤類型（log 只 path+status）────────────────────────────────────────

export class WorkforceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
  ) {
    super(`workforce API ${status} ${path}`);
    this.name = "WorkforceApiError";
  }
}

const WORKFORCE_TIMEOUT_MS = 3000;

// ── HTTP（real mode）─────────────────────────────────────────────────────

async function wfGet(path: string, params: Record<string, string>) {
  if (process.env.WORKFORCE_MOCK === "1") return mockFixture(path, params); // §4
  const url = new URL(path, process.env.WORKFORCE_API_URL); // http://127.0.0.1:<port>
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": process.env.WORKFORCE_API_KEY ?? "" },
      signal: AbortSignal.timeout(WORKFORCE_TIMEOUT_MS),
    });
  } catch (err) {
    // timeout / DNS / 拒接 — log 只 path（零 body；err message 唔會含 key）
    log.warn({ path, err: err instanceof Error ? err.name : "network" }, "workforce: fetch failed");
    throw new WorkforceApiError(0, path);
  }
  if (!res.ok) {
    // ★ log 只 path + status（零 body — 401 都唔洩 response 內容）
    log.warn({ path, status: res.status }, "workforce: non-2xx");
    throw new WorkforceApiError(res.status, path);
  }
  log.debug({ path, status: res.status }, "workforce: fetch ok");
  return res.json();
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

export async function fetchDutyRoster(clinicCode: string, date: string): Promise<WorkforceDuty> {
  return DutySchema.parse(await wfGet("/api/external/v1/duty-roster", { clinicCode, date }));
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
//   .dev/workforce-mock-fill.json   [ {clinicCode, providerApricotId, date, startTime} ]
//                                       → 指定 slot 標滿（測「flow 中途變滿」precheck 路徑）
// - env 旗：WORKFORCE_MOCK_FAIL=1 / WORKFORCE_MOCK_STALE=1（全店，手動測用）

export const MOCK_FAIL_FLAG = ".dev/workforce-mock-fail.json";
export const MOCK_STALE_FLAG = ".dev/workforce-mock-stale.json";
export const MOCK_FILL_FLAG = ".dev/workforce-mock-fill.json";
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/external-v1-availability.json");

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
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

function readFillFlags(): { clinicCode: string; providerApricotId: string; date: string; startTime: string }[] {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(process.cwd(), MOCK_FILL_FLAG), "utf8"));
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter(
      (f) =>
        f &&
        typeof f.clinicCode === "string" &&
        typeof f.providerApricotId === "string" &&
        typeof f.date === "string" &&
        typeof f.startTime === "string"
    );
  } catch {
    return [];
  }
}

function mockFixture(path: string, params: Record<string, string>): unknown {
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

  throw new WorkforceApiError(404, path);
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
        const slots: { start: string; end: string; isOpen: boolean; bookedCount: number }[] = [];
        for (const sch of openSchs) {
          let t = sch.startTime;
          while (t < sch.endTime) {
            const t2 = addMin(t, 30);
            const filled =
              djb2(`${clinicCode}|${p.apricotId}|${date}|${t}`) % 4 === 0 ||
              fillFlags.some((f) => f.providerApricotId === p.apricotId && f.date === date && f.startTime === t);
            slots.push({ start: t, end: t2, isOpen: true, bookedCount: filled ? 1 : 0 });
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
