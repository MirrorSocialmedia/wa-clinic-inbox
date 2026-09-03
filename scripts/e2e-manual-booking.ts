/**
 * e2e-manual-booking — G-3 人手落單（cwi-writeword-20260904）SOP e2e（mock workforce — 決定性）
 *
 * section 編號續 e2e-schedule-ui T131 之後（T132–T138）。
 * contract 模式跟 e2e-booking-ui（cwi-bkui）：in-process（seal cookie + route import）、
 * WORKFORCE_MOCK=1、.dev mock 檔 backup/restore、best-effort cleanup + 0 殘留斷言。
 *
 * T132 落單揀**未來非繁忙時段**（mock getBookableSlots 揀 — SOP 原式）→ 人手落單 200
 *      → CONFIRMED + apricotApptId + W AuditLog BOOKING_CREATE + mock call log POST 200
 *      + mock booked store（= mock 版 Apricot 行）對數：wa-inbox-<W bookingId>（idempotencyKey，
 *        confirm-core.ts:125）↔ mock-appt-<hash>（store 入面嘅 apricotApptId）↔ BookingRequest.apricotApptId。
 *      （真 F 側嘅 ExternalApiAudit 對數喺生產 — 見 docs/runbook-writeword-20260904.md §4；
 *        mock 環境 F 唔存在，booked store + call log 係對等物。）
 * T133 409 雙路：(a) L2 預檢（slot 行 bookedCount=1 → 409 + 0 次 workforce call）
 *      (b) SLOT_TAKEN flag file（workforce 側 409 → 卡保持 PENDING 可重試）
 * T134 新客 422 鐵律：未釘住 conv → 422 NEW_PATIENT_DISABLED + 0 次 workforce call + 0 BookingRequest
 * T135 Send Lock：assignee 係其他人 → 423 SEND_LOCKED
 * T136 過去時段 → 400 slot_in_past；別店 staff → 403
 * T137 成功後**即 remove 清場**（rollback 5 分鐘窗）→ remove call 200 + 卡復原 PENDING
 *      + BOOKING_ROLLBACK + booked store 清
 * T138 audit 齊全（BOOKING_CREATE/ROLLBACK 各 1）+ fixture 0 殘留
 *
 * TEST 前綴檔案：mock patient 檔 / contact profileName 一律 `TEST E2E` 前綴（SOP §測試資料）。
 *
 * 用法（repo root，DB 起緊）：pnpm e2e:manual-booking
 * 退出碼：0 = 全過（含 SKIP-無DB）；1 = 有 fail
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
process.env.WORKFORCE_MOCK = "1";

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { sealData } from "iron-session";
import { Prisma } from "@prisma/client";

import prisma from "../src/lib/prisma";
import { SESSION_COOKIE_NAME, sessionOptions, type SessionData } from "../src/lib/session";
import { phoneHash } from "../src/lib/phone-hash";
import { getBookableSlots } from "../src/lib/workforce/client";
import { MOCK_CALLS_LOG, MOCK_SLOT_TAKEN_FLAG, MOCK_BOOKED_FILE } from "../src/lib/workforce/client";
import * as manualRoute from "../src/app/api/bookings/manual/route";
import * as rollbackRoute from "../src/app/api/bookings/[id]/rollback/route";

const CALLS_LOG = path.resolve(process.cwd(), MOCK_CALLS_LOG);
const SLOT_TAKEN_FLAG = path.resolve(process.cwd(), MOCK_SLOT_TAKEN_FLAG);
const BOOKED_STORE = path.resolve(process.cwd(), MOCK_BOOKED_FILE);
const PATIENTS_FILE = path.resolve(process.cwd(), ".dev/workforce-mock-patients.json");
const E2E_PREFIX = "e2e-mb-";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
function addDaysISO(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function hkToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// mock call log（path+status）
function callsSince(ts: number): { method: string; path: string; status: number }[] {
  if (!existsSync(CALLS_LOG)) return [];
  return readFileSync(CALLS_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as { method?: unknown; path?: unknown; status?: unknown; ts?: unknown } | null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { method: string; path: string; status: number; ts: string } =>
      x !== null && typeof x.method === "string" && typeof x.path === "string" && typeof x.status === "number" && typeof x.ts === "string"
    )
    .filter((x) => new Date(x.ts).getTime() >= ts);
}

async function sealedCookie(staff: { id: string; email: string; name: string }, clinicId: string | null): Promise<string> {
  const data: SessionData = {
    staffId: staff.id,
    email: staff.email,
    name: staff.name,
    role: "STAFF",
    clinicId,
    loginAt: Date.now(),
  };
  return sealData(data as object, sessionOptions());
}
type Ctx = { params: Promise<{ id: string }> };
async function callId(handler: (req: NextRequest, ctx: Ctx) => Promise<unknown>, cookie: string, id: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest("http://localhost/api/e2e", {
    method: "POST",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = (await handler(req, { params: Promise.resolve({ id }) })) as { status: number; json: () => Promise<unknown> };
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
async function callPlain(handler: (req: NextRequest) => Promise<unknown>, cookie: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest("http://localhost/api/e2e", {
    method: "POST",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = (await handler(req)) as { status: number; json: () => Promise<unknown> };
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
function readBooked(): { apricotApptId: string; clinicCode: string; providerApricotId: string; date: string; start: string }[] {
  try {
    const p = JSON.parse(readFileSync(BOOKED_STORE, "utf8")) as unknown;
    if (!Array.isArray(p)) return [];
    return (p as { apricotApptId?: unknown; clinicCode?: unknown; providerApricotId?: unknown; date?: unknown; start?: unknown }[]).filter(
      (e):
        e is { apricotApptId: string; clinicCode: string; providerApricotId: string; date: string; start: string } =>
        typeof e.apricotApptId === "string" && typeof e.clinicCode === "string" && typeof e.providerApricotId === "string" && typeof e.date === "string" && typeof e.start === "string"
    );
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  let dbOk = false;
  try {
    await withTimeout(prisma.$queryRaw(Prisma.sql`SELECT 1`), 4000);
    dbOk = true;
  } catch {
    /* down */
  }
  if (!dbOk) {
    console.log("e2e-manual-booking: DB 唔到 → T132–T138 SKIP（部署環境跑：pnpm e2e:manual-booking）");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  }

  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  if (!clinic) {
    console.error("FAIL: 搵唔到 TKW clinic（seed 先跑）");
    process.exit(1);
  }
  // env 模式 visit reason（跟 cwi-bkui 現狀 — BOOKING_DEFAULT_VISIT_REASON_CODE）
  const dictFx = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "test/fixtures/external-v1-dictionaries.json"), "utf8")
  ) as Record<string, { apricotId: string; code: string }[]>;
  const VR = dictFx.VISIT_REASON?.[0];
  if (!VR) {
    console.error("FAIL: dictionaries fixture 冇 VISIT_REASON");
    process.exit(1);
  }
  process.env.BOOKING_DEFAULT_VISIT_REASON_CODE = VR.code;

  const suffix = String(Date.now()).slice(-8);
  const staff1 = await prisma.staffUser.create({
    data: { email: `${E2E_PREFIX}s1-${suffix}@e2e.test`, passwordHash: "e2e-not-used", name: "TEST E2E S1", role: "STAFF", clinicId: clinic.id },
  });
  const staff2 = await prisma.staffUser.create({
    data: { email: `${E2E_PREFIX}s2-${suffix}@e2e.test`, passwordHash: "e2e-not-used", name: "TEST E2E S2", role: "STAFF", clinicId: clinic.id },
  });
  const contact = await prisma.contact.create({
    data: { clinicId: clinic.id, waId: `1555${suffix}1`, profileName: "TEST E2E 舊客" },
  });
  // Conversation @@unique([clinicId, contactId]) — 每 conv 一個 contact
  const contactB = await prisma.contact.create({ data: { clinicId: clinic.id, waId: `1555${suffix}2`, profileName: "TEST E2E 舊客B" } });
  const contactC = await prisma.contact.create({ data: { clinicId: clinic.id, waId: `1555${suffix}3`, profileName: "TEST E2E 舊客C" } });
  const contactD = await prisma.contact.create({ data: { clinicId: clinic.id, waId: `1555${suffix}4`, profileName: "TEST E2E 舊客D" } });
  const convIds = [contact.id, contactB.id, contactC.id, contactD.id];
  const now = new Date();
  const mkConv = async (c: { id: string }, assigneeId: string | null, pin: boolean) =>
    prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: c.id,
        status: "OPEN",
        assigneeId,
        lastInboundAt: now,
        lastMessageAt: now,
        aiSummary: "TEST 牙痛三日，想預約",
        ...(pin
          ? {
              pinnedPatientApricotId: "pt-mb-e2e",
              pinnedPatientName: "TEST E2E 舊客",
              pinnedPhoneHash: phoneHash(c.id),
            }
          : {}),
      },
    });
  const convA = await mkConv(contact, null, true); // T132/137 成功 + rollback
  const convB = await mkConv(contactB, null, true); // T133 409
  const convC = await mkConv(contactC, null, false); // T134 未釘住
  const convD = await mkConv(contactD, staff2.id, true); // T135 Send Lock

  // ── SOP：落單揀未來非繁忙時段（mock getBookableSlots — 明日起步，唔會 closed 就 +1）──
  let target: { date: string; start: string; providerId: string; providerName: string } | null = null;
  for (let i = 1; i <= 14 && !target; i++) {
    const d = addDaysISO(hkToday(), i);
    const res = await getBookableSlots("TKW", d, d);
    const day = res.days[0];
    const slot = !day.closed ? day.slots[0] : undefined;
    if (slot) target = { date: day.date, start: slot.start, providerId: slot.providerId, providerName: slot.providerName };
  }
  if (!target) {
    console.error("FAIL: mock availability 14 日內搵唔到未來非繁忙時段");
    process.exit(1);
  }
  console.log(`  target slot: ${target.date} ${target.start} ${target.providerName}（未來非繁忙 — mock availability）`);

  // L2 seed：呢格有行（open、未佔）→ 預檢 pass 路徑
  const slotKey = {
    clinicId: clinic.id,
    providerApricotId: target.providerId,
    date: target.date,
    startTime: target.start,
  };
  // ★ L2 row 用 composite-key upsert：T132 成功後 confirm-core 會 invalidateAvailabilityDay
  //   （刪該日 L2 row + 用 availability fixture 重填 — fixture 只有 2026-08-21 過去日 →
  //   未來日嘅 row 會冇）→ 每個要行預檢嘅步驟前先 upsert 埋。
  const upsertSlot = (bookedCount: number) =>
    prisma.availabilitySlot.upsert({
      where: { clinicId_providerApricotId_date_startTime: slotKey },
      create: {
        ...slotKey,
        endTime: target.start.replace(/:(\d{2})$/, (_m, m) => `:${String((Number(m) + 15) % 60).padStart(2, "0")}`),
        bookedCount,
        isOpen: true,
        syncedAt: new Date(),
      },
      update: { bookedCount, isOpen: true, syncedAt: new Date() },
    });

  // mock patient 檔（TEST 前綴；先 backup）— 只須 convA 嗰個 phoneHash（落單用 convA）
  let patientsBackup: string | null = null;
  if (existsSync(PATIENTS_FILE)) patientsBackup = readFileSync(PATIENTS_FILE, "utf8");
  writeFileSync(
    PATIENTS_FILE,
    JSON.stringify(
      {
        byPhoneHash: {
          [phoneHash(contact.id)]: {
            matches: [
              {
                patientApricotId: "pt-mb-e2e",
                patientCode: "TEST01",
                patientName: "TEST E2E 舊客",
                lastVisit: { date: "2026-07-01", providerName: target.providerName, visitReasons: "牙痛" },
              },
            ],
            appointments: [],
          },
        },
      },
      null,
      2
    )
  );
  // 先清舊 store/flag（決定性起點）
  rmSync(BOOKED_STORE, { force: true });
  rmSync(SLOT_TAKEN_FLAG, { force: true });

  const cookie1 = await sealedCookie(staff1, clinic.id);
  const cookie2 = await sealedCookie(staff2, clinic.id);
  const manual = (cookie: string, convId: string, over: Record<string, unknown> = {}) =>
    callPlain(manualRoute.POST as (req: NextRequest) => Promise<unknown>, cookie, {
      conversationId: convId,
      providerApricotId: target!.providerId,
      providerName: target!.providerName,
      date: target!.date,
      start: target!.start,
      ...over,
    });

  let bookingAId = "";
  let apricotA = "";
  try {
    // ── T132 未來非繁忙時段 → 人手落單 200 → 全鏈對數 ─────────────────────
    console.log("\n[T132] 人手落單成功鏈（env 模式 visit reason）");
    await upsertSlot(0);
    const t132 = Date.now();
    const r132 = await manual(cookie1, convA.id);
    check("manual 200", r132.status === 200, `got ${r132.status} ${JSON.stringify(r132.body)}`);
    bookingAId = String(r132.body?.bookingId ?? "");
    apricotA = String(r132.body?.apricotApptId ?? "");
    check("response 帶 bookingId + apricotApptId", !!bookingAId && /^mock-appt-[0-9a-f]{8}$/.test(apricotA), JSON.stringify(r132.body));

    const bkA = await prisma.bookingRequest.findUnique({ where: { id: bookingAId } });
    check(
      "BookingRequest CONFIRMED + apricotApptId + env visitReasonCode",
      bkA?.status === "CONFIRMED" && bkA?.apricotApptId === apricotA && bkA?.visitReasonCode === VR.code && bkA?.autoBooked === false,
      `status=${bkA?.status} code=${bkA?.visitReasonCode}`
    );
    const auditA = await prisma.auditLog.findFirst({ where: { action: "BOOKING_CREATE", entityId: bookingAId } });
    check(
      "W AuditLog BOOKING_CREATE 對數（meta.apricotApptId = BookingRequest.apricotApptId）",
      !!auditA && (auditA.meta as Record<string, unknown>)?.apricotApptId === apricotA && (auditA.meta as Record<string, unknown>)?.clinicId === clinic.id,
      JSON.stringify(auditA?.meta)
    );
    const calls132 = callsSince(t132);
    check("mock call log：POST /bookings 200（idempotencyKey=wa-inbox-<bookingId>）", calls132.some((c) => c.method === "POST" && c.path === "/api/external/v1/bookings" && c.status === 200), JSON.stringify(calls132));
    const storeA = readBooked();
    check(
      "mock booked store（= mock Apricot 行）對數：apricotApptId + slot 全對",
      storeA.some((e) => e.apricotApptId === apricotA && e.clinicCode === "TKW" && e.providerApricotId === target.providerId && e.date === target.date && e.start === target.start),
      JSON.stringify(storeA)
    );

    // ── T133 409 雙路 ─────────────────────────────────────────────────────
    console.log("\n[T133] 409 雙路（L2 預檢 / workforce flag）");
    await upsertSlot(1);
    const t133a = Date.now();
    const r133a = await manual(cookie1, convB.id);
    check("L2 預檢：slot 已佔 → 409 SLOT_TAKEN", r133a.status === 409 && r133a.body?.error === "SLOT_TAKEN", `got ${r133a.status} ${JSON.stringify(r133a.body)}`);
    check("L2 預檢擋咗 → 0 次 workforce call", !callsSince(t133a).some((c) => c.path === "/api/external/v1/bookings" && c.method === "POST"));

    await upsertSlot(0);
    writeFileSync(SLOT_TAKEN_FLAG, JSON.stringify([{ clinicCode: "TKW", providerApricotId: target.providerId, date: target.date, start: target.start }], null, 1));
    const t133b = Date.now();
    const r133b = await manual(cookie1, convB.id);
    check("workforce 側 409（SLOT_TAKEN flag）", r133b.status === 409 && r133b.body?.error === "SLOT_TAKEN", `got ${r133b.status} ${JSON.stringify(r133b.body)}`);
    const bkB = await prisma.bookingRequest.findFirst({ where: { conversationId: convB.id } });
    check("409 後卡保持 PENDING（可重試語義）", bkB?.status === "PENDING", `status=${bkB?.status}`);
    rmSync(SLOT_TAKEN_FLAG, { force: true });

    // ── T134 新客 422 鐵律 ────────────────────────────────────────────────
    console.log("\n[T134] 未釘住 conv → 422 NEW_PATIENT_DISABLED（鐵律）");
    const t134 = Date.now();
    const r134 = await manual(cookie1, convC.id);
    check("422 NEW_PATIENT_DISABLED", r134.status === 422 && r134.body?.error === "NEW_PATIENT_DISABLED", `got ${r134.status} ${JSON.stringify(r134.body)}`);
    check("0 次 workforce call + 0 BookingRequest", !callsSince(t134).some((c) => c.path === "/api/external/v1/bookings") && (await prisma.bookingRequest.findFirst({ where: { conversationId: convC.id } })) === null);

    // ── T135 Send Lock ────────────────────────────────────────────────────
    console.log("\n[T135] Send Lock（assignee 係其他人）→ 423");
    const r135 = await manual(cookie1, convD.id);
    check("423 SEND_LOCKED", r135.status === 423 && r135.body?.error === "SEND_LOCKED", `got ${r135.status} ${JSON.stringify(r135.body)}`);
    // 負責人自己 → 唔係 423（繼續行；落單會成功 → 之後 cleanup 清）
    const r135b = await manual(cookie2, convD.id);
    check("負責人自己 → 唔係 423", r135b.status !== 423, `got ${r135b.status}`);

    // ── T136 過去時段 400 / 別店 403 ──────────────────────────────────────
    console.log("\n[T136] 過去時段 → 400 slot_in_past；別店 staff → 403");
    const yesterday = addDaysISO(hkToday(), -1);
    const r136a = await manual(cookie1, convA.id, { date: yesterday, start: "10:00" });
    check("過去時段 400 slot_in_past", r136a.status === 400 && r136a.body?.error === "slot_in_past", `got ${r136a.status} ${JSON.stringify(r136a.body)}`);
    const clinicOther = await prisma.clinic.findUnique({ where: { code: "MF" } });
    if (clinicOther) {
      const staffOther = await prisma.staffUser.create({
        data: { email: `${E2E_PREFIX}so-${suffix}@e2e.test`, passwordHash: "e2e-not-used", name: "TEST E2E SO", role: "STAFF", clinicId: clinicOther.id },
      });
      const cookieOther = await sealedCookie(staffOther, clinicOther.id);
      const r136b = await callPlain(manualRoute.POST as (req: NextRequest) => Promise<unknown>, cookieOther, {
        conversationId: convA.id,
        providerApricotId: target.providerId,
        providerName: target.providerName,
        date: target.date,
        start: target.start,
      });
      check("別店 staff → 403", r136b.status === 403, `got ${r136b.status}`);
      await prisma.staffUser.delete({ where: { id: staffOther.id } });
    } else {
      check("別店 403（MF clinic 唔存在 — seed 差異）", false, "MF clinic missing");
    }

    // ── T137 成功後即 remove 清場（rollback 5 分鐘窗）────────────────────
    console.log("\n[T137] 即 remove 清場（rollback）");
    const t137 = Date.now();
    const r137 = await callId(rollbackRoute.POST as (req: NextRequest, ctx: Ctx) => Promise<unknown>, cookie1, bookingAId);
    check("rollback 200（5 分鐘窗內）", r137.status === 200, `got ${r137.status} ${JSON.stringify(r137.body)}`);
    const calls137 = callsSince(t137);
    check(
      "mock call log：PUT /bookings/<appt>/remove 200",
      calls137.some((c) => c.method === "PUT" && c.status === 200 && c.path === `/api/external/v1/bookings/${apricotA}/remove`),
      JSON.stringify(calls137)
    );
    const bkA2 = await prisma.bookingRequest.findUnique({ where: { id: bookingAId } });
    check("卡復原 PENDING + apricotApptId 清", bkA2?.status === "PENDING" && bkA2?.apricotApptId === null, `status=${bkA2?.status}`);
    const auditR = await prisma.auditLog.findFirst({ where: { action: "BOOKING_ROLLBACK", entityId: bookingAId } });
    check("W AuditLog BOOKING_ROLLBACK 存在", !!auditR);
    check("mock booked store 清咗（capacity 還原）", !readBooked().some((e) => e.apricotApptId === apricotA));

    // ── T138 audit 齊全 ───────────────────────────────────────────────────
    console.log("\n[T138] audit 齊全");
    const nCreate = await prisma.auditLog.count({ where: { action: "BOOKING_CREATE", entityId: bookingAId } });
    const nRoll = await prisma.auditLog.count({ where: { action: "BOOKING_ROLLBACK", entityId: bookingAId } });
    check("BOOKING_CREATE ×1 + BOOKING_ROLLBACK ×1", nCreate === 1 && nRoll === 1, `create=${nCreate} rollback=${nRoll}`);
  } finally {
    // ── cleanup（best-effort）+ 0 殘留斷言 ───────────────────────────────
    // audit entityId = conversationId（指派等）或 bookingId（BOOKING_CREATE/ROLLBACK）— 兩類都清
    const convAll = [convA.id, convB.id, convC.id, convD.id];
    const allBookingIds = (await prisma.bookingRequest.findMany({ where: { conversationId: { in: convAll } }, select: { id: true } })).map((b) => b.id);
    try {
      await prisma.$transaction([
        prisma.availabilitySlot.deleteMany({ where: slotKey }),
        prisma.message.deleteMany({ where: { conversationId: { in: convAll } } }),
        prisma.bookingRequest.deleteMany({ where: { conversationId: { in: convAll } } }),
        prisma.auditLog.deleteMany({ where: { entityId: { in: [...convAll, ...allBookingIds] } } }),
        prisma.conversation.deleteMany({ where: { contactId: { in: convIds } } }),
        prisma.contact.deleteMany({ where: { id: { in: convIds } } }),
        prisma.staffUser.delete({ where: { id: staff1.id } }),
        prisma.staffUser.delete({ where: { id: staff2.id } }),
      ]);
    } catch (e) {
      console.error(`cleanup 部分失敗（手動清 ${E2E_PREFIX}*${suffix}* 殘留）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (patientsBackup !== null) writeFileSync(PATIENTS_FILE, patientsBackup);
    else rmSync(PATIENTS_FILE, { force: true });
    rmSync(SLOT_TAKEN_FLAG, { force: true });
    rmSync(BOOKED_STORE, { force: true });
    rmSync(CALLS_LOG, { force: true });

    // 0 殘留（本批 fixture）
    const leftConv = await prisma.conversation.count({ where: { contactId: { in: convIds } } });
    const leftStaff = await prisma.staffUser.count({ where: { email: { endsWith: `-${suffix}@e2e.test` } } });
    const leftBook = await prisma.bookingRequest.count({ where: { conversationId: { in: convAll } } });
    check("0 殘留（conv/booking/audit/slot）", leftConv === 0 && leftBook === 0, `conv=${leftConv} booking=${leftBook}`);
    check("0 殘留（e2e-mb- staff）", leftStaff === 0, `left=${leftStaff}`);
    check("mock 檔已清（patients restore / slot-taken / booked / calls）", !existsSync(SLOT_TAKEN_FLAG) && !existsSync(BOOKED_STORE) && !existsSync(CALLS_LOG));
  }

  await prisma.$disconnect();
  console.log(failures === 0 ? "\nE2E PASS ✅（manual-booking T132–T138）" : `\nE2E FAIL ❌（${failures} 項）`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
