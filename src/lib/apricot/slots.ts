/**
 * Apricot 空檔 sync — 讀 getOverviewAppointments → 算 AvailabilitySlot（MD §8.1）
 *
 * ★ 兩個已知陷阱（照防）：
 * 1. `doctorIds` 要**逐個列**（新醫生會靜靜漏）— 本 module 逐個 doctor 發 request；
 *    名錄來源 = Provider/ProviderClinic 表（mock 期由 seed 派生；real 期可由
 *    APRICOT_DOCTORS_PATH 自動 sync — syncClinic 第一步先刷新名錄再拉空檔）。
 * 2. `openSchClinicId` 係**單數** — 要逐店 loop（每間 clinic 一輪 doctor loop）。
 *
 * 🔴 PII 白名單：raw response 落地前必過 sanitizeOverview() + assertNoPii()；
 * raw 永不入 log 永不落 disk。log 只准 metadata（店/醫生 id/日期範圍/slot 數）。
 *
 * slot 模型：開診時段切 30 分鐘 slot；預約同 slot 有 overlap = 佔用（bookedCount++）；
 * bookedCount>=1 = 滿。只有開診時段會產 row（唔開診 = 無 row = Flow 唔會顯示）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { apricotCall } from "./client";
import { saveCreds, markError, apricotMock } from "./session";
import { sanitizeOverview, assertNoPii, type SanitizedOverview } from "./sanitize";
import { mockOverviewRaw, SLOT_MINUTES } from "./mock";

// ── HK 日期（UTC+8 固定，無 DST） ────────────────────────────────────────

export function hkTodayStr(now: Date = new Date()): string {
  const hk = new Date(now.getTime() + 8 * 3600 * 1000);
  return hk.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** 窗口：聽日 ~ +30 日（HK 日界 — 同 Flow DatePicker min=聽日 max=+30 對齊） */
export function syncWindow(now: Date = new Date()): { start: string; end: string; dates: string[] } {
  const today = hkTodayStr(now);
  const start = addDays(today, 1);
  const end = addDays(today, 30);
  const dates: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  return { start, end, dates };
}

// ── day-entry 解析（real/mock 共用） ─────────────────────────────────────

export interface DayRaw {
  date: string;
  practitionerOpenSchs: unknown[];
  appointments: unknown[];
  [k: string]: unknown;
}

/**
 * raw overview response → 逐日 entries。
 * 收兩種 shape（real 機對接後如對唔上，只改呢度 — README 真機驗收清單有列）：
 * - array：逐日 entry（{ date/openSchDate, practitionerOpenSchs, appointments }）
 * - object：單日（mock 用；date 由 caller 補）
 */
export function parseDayEntries(raw: unknown, fallbackDate?: string): DayRaw[] {
  if (Array.isArray(raw)) {
    return raw
      .map((e: unknown): DayRaw | null => {
        const eo = (e ?? {}) as Record<string, unknown>;
        const date = String(eo.date ?? eo.openSchDate ?? eo.day ?? fallbackDate ?? "");
        if (!date) return null;
        return {
          date: date.slice(0, 10),
          practitionerOpenSchs: Array.isArray(eo.practitionerOpenSchs) ? eo.practitionerOpenSchs : [],
          appointments: Array.isArray(eo.appointments) ? eo.appointments : [],
          // 其餘欄位（PII bait 等）保留喺 entry — 由 sanitize 白名單 drop
        } as DayRaw;
      })
      .filter((e): e is DayRaw => e !== null);
  }
  if (raw && typeof raw === "object") {
    return [
      {
        date: String((raw as DayRaw).date ?? fallbackDate ?? "").slice(0, 10),
        practitionerOpenSchs: Array.isArray((raw as DayRaw).practitionerOpenSchs)
          ? (raw as DayRaw).practitionerOpenSchs
          : [],
        appointments: Array.isArray((raw as DayRaw).appointments) ? (raw as DayRaw).appointments : [],
      },
    ].filter((e) => !!e.date);
  }
  return [];
}

/** 開診時段 → 30 分鐘 slot（bookedCount = overlap 預約數） */
export function computeSlots(ov: SanitizedOverview): {
  startTime: string;
  endTime: string;
  bookedCount: number;
}[] {
  const out: { startTime: string; endTime: string; bookedCount: number }[] = [];
  for (const sch of ov.openSchs) {
    let t = hhmmToMin(sch.startTime);
    const end = hhmmToMin(sch.endTime);
    while (t + SLOT_MINUTES <= end) {
      const t2 = t + SLOT_MINUTES;
      const booked = ov.appointments.filter((a) => {
        const a1 = hhmmToMin(a.startTime);
        const a2 = hhmmToMin(a.endTime);
        return a1 < t2 && a2 > t; // overlap
      }).length;
      const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      out.push({ startTime: fmt(t), endTime: fmt(t2), bookedCount: booked });
      t = t2;
    }
  }
  return out;
}

// ── 醫生名錄（陷阱 1：先 sync 名錄再拉） ─────────────────────────────────

/**
 * 刷新該店醫生名錄（Provider/ProviderClinic）。
 * - real + APRICOT_DOCTORS_PATH 設定：由 Apricot API 拉（白名單只留 id+name）
 * - 其他（mock 期）：名錄已由 seed 派生 — no-op（讀 DB 現值）
 * 返回該店 active 醫生（有 apricotId 先會拉空檔）。
 */
export async function syncDoctorRoster(clinicId: string): Promise<{ id: string; name: string; apricotId: string }[]> {
  const customPath = process.env.APRICOT_DOCTORS_PATH ?? "";
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) throw new Error("clinic not found");

  if (!apricotMock() && customPath) {
    const qs = customPath.includes("?") ? "&" : "?";
    const raw = await apricotCall(
      `${customPath}${qs}openSchClinicId=${encodeURIComponent(clinic.apricotClinicId ?? "")}`
    );
    // 白名單 pickup：只留 id + name（doctor 名非病人 PII，可留）
    const toArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    let list: unknown[] = toArr(raw);
    if (list.length === 0 && raw && typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      list = toArr(o.list);
      if (list.length === 0) list = toArr(o.content);
    }
    for (const dRaw of list) {
      const d = (dRaw && typeof dRaw === "object" ? dRaw : {}) as Record<string, unknown>;
      const apricotId = String(d.id ?? d.extId ?? "").trim();
      const name = String(d.name ?? d.nameDes ?? d.des ?? "").trim();
      if (!apricotId || !name) continue;
      const provider = await prisma.provider.upsert({
        where: { apricotId },
        update: { name, active: true },
        create: { name, apricotId },
      });
      await prisma.providerClinic.upsert({
        where: { providerId_clinicId: { providerId: provider.id, clinicId } },
        update: {},
        create: { providerId: provider.id, clinicId },
      });
    }
    log.info({ clinic: clinic.code, source: "apricot-api", count: list.length }, "apricot: doctor roster synced");
  }

  const rows = await prisma.providerClinic.findMany({
    where: { clinicId, provider: { active: true, apricotId: { not: null } } },
    include: { provider: true },
  });
  return rows.map((r) => ({ id: r.provider.id, name: r.provider.name, apricotId: r.provider.apricotId! }));
}

// ── 主 sync（一間店） ────────────────────────────────────────────────────

export interface SyncClinicResult {
  clinicCode: string;
  doctors: number;
  dates: number;
  slotsCreated: number;
  slotsFull: number;
  mock: boolean;
}

/**
 * 同步一間店嘅空檔（cron 15 分鐘 / 員工手動 refresh 都入呢度）。
 * ★ 只可經 apricot worker（concurrency=1）call — 嚴禁別處直接 call。
 */
export async function syncClinic(clinicId: string, now: Date = new Date()): Promise<SyncClinicResult> {
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) throw new Error("clinic not found");
  if (!clinic.apricotClinicId) {
    log.warn({ clinic: clinic.code }, "apricot: clinic 無 apricotClinicId — skip（admin 未填）");
    return { clinicCode: clinic.code, doctors: 0, dates: 0, slotsCreated: 0, slotsFull: 0, mock: apricotMock() };
  }

  // 陷阱 1：先 sync 醫生名錄（新醫生會靜靜漏）
  const doctors = await syncDoctorRoster(clinic.id);
  if (doctors.length === 0) {
    log.warn({ clinic: clinic.code }, "apricot: 無醫生名錄（Provider 表空）— skip 拉空檔");
    return { clinicCode: clinic.code, doctors: 0, dates: 0, slotsCreated: 0, slotsFull: 0, mock: apricotMock() };
  }

  const { start, end, dates } = syncWindow(now);
  const mock = apricotMock();
  let slotsCreated = 0;
  let slotsFull = 0;

  // 陷阱 1（續）：doctorIds 逐個列 — 一個 doctor 一輪 request
  for (const doctor of doctors) {
    const dayRaws: DayRaw[] = [];
    if (mock) {
      // mock：逐日決定性 fixture（shape 同真 response 對齊，連 PII bait 一齊過 sanitize）
      for (const date of dates) {
        dayRaws.push({ ...mockOverviewRaw({ clinicCode: clinic.code, providerApricotId: doctor.apricotId, date }), date });
      }
    } else {
      // real：一網打盡（date 範圍）— openSchClinicId 單數 = 呢間店（陷阱 2：逐店 loop 喺 caller）
      const raw = await apricotCall(
        `/services/aepsmsappt/api/appointments/getOverviewAppointments` +
          `?startDate=${start}&endDate=${end}` +
          `&doctorIds=${encodeURIComponent(doctor.apricotId)}` +
          `&openSchClinicId=${encodeURIComponent(clinic.apricotClinicId)}`
      );
      dayRaws.push(...parseDayEntries(raw));
    }

    // 重同步 = 該 (店,醫生,窗口) 範圍先清後寫（決定性；唔會累積陳舊 row）
    // ★ delete 一次（窗口級）— 放住逐日 loop 入面會每日清掉前一日新寫嘅 row（只餘最後一日）
    await prisma.availabilitySlot.deleteMany({
      where: { clinicId: clinic.id, providerApricotId: doctor.apricotId, date: { gte: start, lte: end } },
    });

    for (const dayRaw of dayRaws) {
      // 🔴 PII 白名單：落地前過濾 + 斷言
      const sanitized = sanitizeOverview(dayRaw);
      assertNoPii(sanitized);
      const slots = computeSlots(sanitized);
      if (slots.length > 0) {
        const rows = slots.map((s) => ({
          clinicId: clinic.id,
          providerApricotId: doctor.apricotId,
          date: dayRaw.date,
          startTime: s.startTime,
          endTime: s.endTime,
          bookedCount: s.bookedCount,
          isOpen: true,
          syncedAt: now,
        }));
        await prisma.availabilitySlot.createMany({ data: rows });
        slotsCreated += rows.length;
        slotsFull += rows.filter((r) => r.bookedCount > 0).length;
      }
    }
  }

  // heartbeat（14 日 token 唔死嘅監控證據 — metadata only）
  const creds = await (await import("./session")).loadCreds();
  if (creds) {
    await saveCreds(creds, { lastSyncAt: now, rotate: false });
  } else if (mock) {
    await (await import("./session")).ensureMockSession();
  }

  log.info(
    {
      clinic: clinic.code,
      doctors: doctors.length,
      range: `${start}..${end}`,
      slotsCreated,
      slotsFull,
      mock,
    },
    "apricot: heartbeat — availability sync ok"
  );
  return { clinicCode: clinic.code, doctors: doctors.length, dates: dates.length, slotsCreated, slotsFull, mock };
}

/** 全站 loop（cron sync-availability / 員工手動 refresh 用；陷阱 2：openSchClinicId 單數逐店） */
export async function syncAllClinics(now: Date = new Date()): Promise<SyncClinicResult[]> {
  const clinics = await prisma.clinic.findMany({ where: { apricotClinicId: { not: null } } });
  const results: SyncClinicResult[] = [];
  for (const c of clinics) {
    try {
      results.push(await syncClinic(c.id, now));
    } catch (err) {
      // 單店失敗唔阻其他店（下一輪 15 分鐘會再試）
      const msg = err instanceof Error ? err.message : String(err);
      await markError(`sync ${c.code}: ${msg}`);
      log.error({ clinic: c.code, err: msg }, "apricot: sync clinic failed（下一輪重試）");
    }
  }
  return results;
}
