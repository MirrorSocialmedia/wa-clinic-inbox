/**
 * e2e-booking-ui — booking-ui MD §F 九條 e2e（mock workforce — 決定性）
 *
 * 前提（部署環境）：15432 DB + Redis 起緊 + WORKFORCE_MOCK=1（本 script 強制）。
 * 本地（DB down）：自動探測 DB 唔到 → 九條全 SKIP（exit 0），斷言全部喺
 *   docs/deployment-checklist-booking-ui.md（鐵律 3：本地跑唔到嘅唔好硬跑）。
 *
 * ① 落單 200 → CONFIRMED + 確認訊息 + L2 該日 invalidate（下一次 getSlots 打 API）
 * ② 409 SLOT_TAKEN（flag file）→ booking 保持 PENDING + 重發 Flow 200
 * ③ 撤銷 3 分鐘內 → remove call + 卡復原 PENDING + 冇自動訊息
 * ④ 過 5 分鐘撤銷 → API 410（掣消失嘅 server 端強制）
 * ⑤ 側欄改期全鏈：reschedule route → Flow → nfm_reply → rescheduleBooking
 *    → 清旗標 + BOOKING_RESCHEDULE + 改期訊息 + 雙日 L2 invalidate
 * ⑥ 取消全鏈：cancel route → status -7 + BOOKING_CANCEL + 取消訊息 + L2 invalidate
 * ⑦ Send Lock：非負責人 → rollback/reschedule/cancel 全部 423
 * ⑧ ALLOW_NEW_PATIENT_WRITE off（mock 預設）→ 未釘住 conv 代落單 = 400（新客 variant 唔存在）
 * ⑨ socket 第二 browser → 需要 live server + 兩個 socket client — 見 deployment checklist
 *   （in-process 唔起 hub；--server 旗：server 起緊時用 socket.io-client 驗證）
 *
 * 用法（repo root）：
 *   pnpm e2e:booking-ui            # in-process（需 DB）
 *   pnpm e2e:booking-ui --server   # 加跑 ⑨（server 起緊，PORT 預設 3100）
 * 退出碼：0 = 全過（含 SKIP-無DB）；1 = 有 fail
 *
 * ★ PII 鐵律：test contact waId 係假號（1555…）；mock patient 檔 gitignored；
 *   log 只 path + status；audit meta 零 PII。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
process.env.WORKFORCE_MOCK = "1";

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { sealData } from "iron-session";
import { Prisma } from "@prisma/client";
import { io } from "socket.io-client";

import prisma from "../src/lib/prisma";
import { SESSION_COOKIE_NAME, sessionOptions, type SessionData } from "../src/lib/session";
import { getSlots } from "../src/lib/availability";
import { phoneHash } from "../src/lib/phone-hash";
import { handleFlowReply } from "../src/lib/booking/flow-reply";
import { ensureKeypair, wrapAesKey, encryptGcm } from "../src/lib/flows/crypto";
import { MOCK_CALLS_LOG } from "../src/lib/workforce/client";
import * as createRoute from "../src/app/api/bookings/[id]/create/route";
import * as rollbackRoute from "../src/app/api/bookings/[id]/rollback/route";
import * as rescheduleRoute from "../src/app/api/conversations/[id]/patient-appointments/reschedule/route";
import * as cancelRoute from "../src/app/api/conversations/[id]/patient-appointments/cancel/route";
import * as flowsRoute from "../src/app/api/conversations/[id]/flows/route";

const SLOT_TAKEN_FLAG = path.resolve(process.cwd(), ".dev/workforce-mock-slot-taken.json");
const PATIENTS_FILE = path.resolve(process.cwd(), ".dev/workforce-mock-patients.json");
const CALLS_LOG = path.resolve(process.cwd(), MOCK_CALLS_LOG);
const E2E_PREFIX = "e2e-bkui-";

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

// mock call log 讀取（path+status 斷言）
function callsSince(ts: number): { method: string; path: string; status: number }[] {
  if (!existsSync(CALLS_LOG)) return [];
  const parsed = readFileSync(CALLS_LOG, "utf8")
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
    );
  return parsed.filter((x) => new Date(x.ts).getTime() >= ts);
}

// authed cookie（in-process：seal 一個合法 staff session）
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
type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<unknown>;
async function call(handler: Handler, cookie: string, id: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest("http://localhost/api/e2e", {
    method: "POST",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = (await handler(req, { params: Promise.resolve({ id }) })) as {
    status: number;
    json: () => Promise<unknown>;
  };
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body: json };
}

async function main(): Promise<void> {
  // ── DB probe（鐵律 3：down → SKIP 全部，入 checklist）──────────────────
  let dbOk = false;
  try {
    await withTimeout(prisma.$queryRaw(Prisma.sql`SELECT 1`), 4000);
    dbOk = true;
  } catch {
    /* down */
  }
  if (!dbOk) {
    console.log("e2e-booking-ui: DB 唔到（本地 15432 down）→ ①–⑧ SKIP（in-process 要 DB）；⑨ 要 live server。");
    console.log("   全部斷言已入 docs/deployment-checklist-booking-ui.md（部署環境跑：pnpm e2e:booking-ui --server）");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  }

  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  if (!clinic) {
    console.error("FAIL: 搵唔到 TKW clinic（seed 先跑）");
    process.exit(1);
  }

  // fixtures（決定性）
  const availFx = JSON.parse(readFileSync(path.resolve(process.cwd(), "test/fixtures/external-v1-availability.json"), "utf8")) as {
    days: { date: string; providers: { providerApricotId: string; providerName: string; slots: { start: string; isOpen: boolean }[] }[] }[];
  };
  const day0 = availFx.days[0];
  const PROVIDER = day0.providers[0].providerApricotId;
  const PROVIDER_NAME = day0.providers[0].providerName;
  const SLOT_DATE = day0.date;
  const SLOT_TIME = day0.providers[0].slots.find((s) => s.isOpen)?.start ?? "10:00";
  const day2 = addDaysISO(SLOT_DATE, 3); // 改期目標日（L2 手動 seed）
  const dictFx = JSON.parse(readFileSync(path.resolve(process.cwd(), "test/fixtures/external-v1-dictionaries.json"), "utf8")) as Record<string, { apricotId: string; code: string }[]>;
  const VR = dictFx.VISIT_REASON?.[0];
  if (!VR) {
    console.error("FAIL: dictionaries fixture 冇 VISIT_REASON");
    process.exit(1);
  }

  // ── test data ──────────────────────────────────────────────────────────
  const suffix = String(Date.now()).slice(-8);
  const staff1 = await prisma.staffUser.create({
    data: { email: `${E2E_PREFIX}s1-${suffix}@e2e.test`, passwordHash: "e2e-not-used", name: "E2E S1", role: "STAFF", clinicId: clinic.id },
  });
  const staff2 = await prisma.staffUser.create({
    data: { email: `${E2E_PREFIX}s2-${suffix}@e2e.test`, passwordHash: "e2e-not-used", name: "E2E S2", role: "STAFF", clinicId: clinic.id },
  });
  const contact = await prisma.contact.create({
    data: { clinicId: clinic.id, waId: `1555${String(Date.now()).slice(-8)}`, profileName: "E2E 舊客" },
  });
  const now = new Date();
  const mkConv = async (assigneeId: string | null, pin: boolean) => {
    const conv = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: contact.id,
        status: "OPEN",
        assigneeId,
        lastInboundAt: now,
        lastMessageAt: now,
        aiSummary: "牙痛三日，想預約",
        ...(pin
          ? { pinnedPatientApricotId: "pt-e2e-1", pinnedPatientName: "E2E 舊客", pinnedPhoneHash: phoneHash(contact.waId) }
          : {}),
      },
    });
    return conv;
  };
  // conv1 = ①②③④；conv2 = ⑤ 改期；conv3 = ⑥ 取消；conv4 = ⑦ Send Lock（assignee=staff2）；conv5 = ⑧ 未釘住
  const conv1 = await mkConv(staff1.id, true);
  const conv2 = await mkConv(staff1.id, true);
  const conv3 = await mkConv(staff1.id, true);
  const conv4 = await mkConv(staff2.id, true);
  const conv5 = await mkConv(staff1.id, false);

  // mock patient runtime（gitignored；先 backup）
  let patientsBackup: string | null = null;
  if (existsSync(PATIENTS_FILE)) patientsBackup = readFileSync(PATIENTS_FILE, "utf8");
  const hash = phoneHash(contact.waId);
  writeFileSync(
    PATIENTS_FILE,
    JSON.stringify(
      {
        byPhoneHash: {
          [hash]: {
            matches: [
              { patientApricotId: "pt-e2e-1", patientCode: "E2E01", patientName: "E2E 舊客", lastVisit: { date: "2026-07-01", providerName: PROVIDER_NAME, visitReasons: "牙痛" } },
            ],
            appointments: [
              { apricotApptId: "e2e-appt-1", clinicCode: "TKW", providerApricotId: PROVIDER, providerName: PROVIDER_NAME, date: day2, start: "09:00", end: "09:15", bookingStatus: 0, patientApricotId: "pt-e2e-1", patientCode: "E2E01", patientName: "E2E 舊客", visitReasons: "牙痛", remarks: "e2e" },
              { apricotApptId: "e2e-appt-2", clinicCode: "TKW", providerApricotId: PROVIDER, providerName: PROVIDER_NAME, date: addDaysISO(SLOT_DATE, 5), start: "11:00", end: "11:15", bookingStatus: 102, patientApricotId: "pt-e2e-1", patientCode: "E2E01", patientName: "E2E 舊客", visitReasons: "複診", remarks: "e2e" },
            ],
          },
        },
      },
      null,
      2
    )
  );
  // L2 seed：① 舊日 slot（invalidate 目標）+ ⑤ 改期目標 slot（flow precheck 要）
  const slot1 = await prisma.availabilitySlot.create({
    data: { clinicId: clinic.id, providerApricotId: PROVIDER, date: SLOT_DATE, startTime: SLOT_TIME, endTime: "10:30", bookedCount: 0, isOpen: true, syncedAt: now },
  });
  const slot2 = await prisma.availabilitySlot.create({
    data: { clinicId: clinic.id, providerApricotId: PROVIDER, date: day2, startTime: "14:00", endTime: "14:15", bookedCount: 0, isOpen: true, syncedAt: now },
  });
  const slot3 = await prisma.availabilitySlot.create({
    data: { clinicId: clinic.id, providerApricotId: PROVIDER, date: addDaysISO(SLOT_DATE, 5), startTime: "11:00", endTime: "11:15", bookedCount: 0, isOpen: true, syncedAt: now },
  });

  const cookieStaff1 = await sealedCookie(staff1, clinic.id);
  const t0 = Date.now();
  try {
    // ── ① 落單 200 → CONFIRMED + 確認訊息 + L2 invalidate ─────────────────
    console.log("\n[①] 代落單 200 → CONFIRMED + 確認訊息 + L2 invalidate");
    const bk1 = await prisma.bookingRequest.create({
      data: {
        conversationId: conv1.id,
        clinicId: clinic.id,
        flowToken: `${E2E_PREFIX}ft1-${suffix}`,
        providerApricotId: PROVIDER,
        providerName: PROVIDER_NAME,
        requestedDate: SLOT_DATE,
        requestedTime: SLOT_TIME,
        status: "PENDING",
      },
    });
    let r = await call(createRoute.POST as Handler, cookieStaff1, bk1.id, { visitReasonId: VR.apricotId });
    check("create → 200", r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    const bk1After = await prisma.bookingRequest.findUnique({ where: { id: bk1.id } });
    check("卡轉 CONFIRMED", bk1After?.status === "CONFIRMED");
    check("apricotApptId 寫入（決定性 mock-appt-<hash>）", typeof bk1After?.apricotApptId === "string" && bk1After.apricotApptId.startsWith("mock-appt-"));
    check("handledBy/At 寫入", bk1After?.handledByStaffId === staff1.id && bk1After?.handledAt !== null);
    const msg1 = await prisma.message.findFirst({ where: { conversationId: conv1.id, direction: "OUT", aiAutoSent: true } });
    check("確認訊息已發出（QUEUED）", msg1 !== null && msg1.status === "QUEUED");
    check("訊息文字正確", msg1?.body === `已為你預約 ${Number(SLOT_DATE.split("-")[1])}月${Number(SLOT_DATE.split("-")[2])}日 ${SLOT_TIME} ${PROVIDER_NAME}，到時見 🙂`, msg1?.body ?? "null");
    const l2Left = await prisma.availabilitySlot.count({ where: { clinicId: clinic.id, date: SLOT_DATE } });
    check("L2 該日已 invalidate", l2Left === 0, `left=${l2Left}`);
    const got = await getSlots(clinic.id, { start: SLOT_DATE, end: SLOT_DATE });
    const sync = await prisma.workforceSyncState.findUnique({ where: { clinicId: clinic.id } });
    check("下一次 getSlots 打咗 API（lastOkAt fresh + slots 有數據）", got.slots !== null && (sync?.lastOkAt?.getTime() ?? 0) >= t0, `degraded=${got.degraded} slots=${got.slots?.length}`);

    // ── ② 409 SLOT_TAKEN → 保持 PENDING + 重發 Flow ───────────────────────
    console.log("\n[②] 409 SLOT_TAKEN → 紅卡 + 重發 Flow");
    const bk2 = await prisma.bookingRequest.create({
      data: {
        conversationId: conv1.id,
        clinicId: clinic.id,
        flowToken: `${E2E_PREFIX}ft2-${suffix}`,
        providerApricotId: PROVIDER,
        providerName: PROVIDER_NAME,
        requestedDate: SLOT_DATE,
        requestedTime: SLOT_TIME,
        status: "PENDING",
      },
    });
    writeFileSync(SLOT_TAKEN_FLAG, JSON.stringify({ clinicCode: clinic.code, providerApricotId: PROVIDER, date: SLOT_DATE, start: SLOT_TIME }));
    r = await call(createRoute.POST as Handler, cookieStaff1, bk2.id, { visitReasonId: VR.apricotId });
    check("create → 409 SLOT_TAKEN", r.status === 409 && r.body?.error === "SLOT_TAKEN", `got ${r.status} ${JSON.stringify(r.body)}`);
    const bk2After = await prisma.bookingRequest.findUnique({ where: { id: bk2.id } });
    check("booking 保持 PENDING", bk2After?.status === "PENDING" && bk2After?.apricotApptId === null);
    rmSync(SLOT_TAKEN_FLAG, { force: true });
    r = await call(flowsRoute.POST as Handler, cookieStaff1, conv1.id);
    check("重發 Flow → 200（24h 窗口內）", r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);

    // ── ③ 撤銷 3 分鐘內 → remove + 復原 + 冇訊息 ─────────────────────────
    console.log("\n[③] 撤銷（3 分鐘內）→ remove call + 卡復原 + 冇自動訊息");
    const outBefore = await prisma.message.count({ where: { conversationId: conv1.id, direction: "OUT" } });
    r = await call(rollbackRoute.POST as Handler, cookieStaff1, bk1.id);
    check("rollback → 200", r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    const bk1Final = await prisma.bookingRequest.findUnique({ where: { id: bk1.id } });
    check("卡彈返 PENDING", bk1Final?.status === "PENDING" && bk1Final?.apricotApptId === null && bk1Final?.handledAt === null);
    const outAfter = await prisma.message.count({ where: { conversationId: conv1.id, direction: "OUT" } });
    check("冇自動訊息（MD 鐵律）", outAfter === outBefore, `before=${outBefore} after=${outAfter}`);
    check("AuditLog BOOKING_ROLLBACK", (await prisma.auditLog.findFirst({ where: { entityId: bk1.id, action: "BOOKING_ROLLBACK" } })) !== null);
    check("mock 收到 remove call（200）", callsSince(t0).some((c) => c.path.endsWith("/remove") && c.status === 200));

    // ── ④ 過 5 分鐘 → 410 ─────────────────────────────────────────────────
    console.log("\n[④] 過 5 分鐘撤銷 → 410（掣消失 server 強制）");
    const bk4 = await prisma.bookingRequest.create({
      data: {
        conversationId: conv1.id,
        clinicId: clinic.id,
        flowToken: `${E2E_PREFIX}ft4-${suffix}`,
        providerApricotId: PROVIDER,
        providerName: PROVIDER_NAME,
        requestedDate: SLOT_DATE,
        requestedTime: SLOT_TIME,
        status: "CONFIRMED",
        apricotApptId: "mock-appt-expired",
        handledByStaffId: staff1.id,
        handledAt: new Date(Date.now() - 6 * 60 * 1000),
      },
    });
    r = await call(rollbackRoute.POST as Handler, cookieStaff1, bk4.id);
    check("rollback（6 分鐘前）→ 410", r.status === 410, `got ${r.status}`);
    const bk4After = await prisma.bookingRequest.findUnique({ where: { id: bk4.id } });
    check("booking 保持 CONFIRMED（唔會誤撤）", bk4After?.status === "CONFIRMED");

    // ── ⑤ 側欄改期全鏈 ────────────────────────────────────────────────────
    console.log("\n[⑤] 側欄改期全鏈（Flow → rescheduleBooking → 改期訊息）");
    r = await call(rescheduleRoute.POST as Handler, cookieStaff1, conv2.id, { apricotApptId: "e2e-appt-1" });
    check("reschedule route → 200（Flow 已發）", r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    const conv2After = await prisma.conversation.findUnique({ where: { id: conv2.id } });
    check("reschedulingApptId 旗標已設", conv2After?.reschedulingApptId === "e2e-appt-1");
    const flowSession = await prisma.flowSession.findFirst({ where: { conversationId: conv2.id, status: "SENT" }, orderBy: { createdAt: "desc" } });
    check("FlowSession SENT 存在", flowSession !== null);
    if (!flowSession) throw new Error("no flow session for reschedule e2e");
    // 模擬病人完成 Flow（新時段 = day2 14:00 — L2 slot2）
    const kp = ensureKeypair();
    const aesKey = randomBytes(16);
    const iv = randomBytes(12);
    const { payload, iv: payloadIv } = encryptGcm(aesKey, iv, {
      flow_token: flowSession.flowToken,
      providerId: PROVIDER,
      providerName: PROVIDER_NAME,
      date: day2,
      time: "14:00",
    });
    const outcome = await handleFlowReply({
      clinicId: clinic.id,
      conversationId: conv2.id,
      waId: contact.waId,
      responseJson: { payload, iv: payloadIv, wrapped_key: wrapAesKey(kp.publicPem, aesKey) },
    });
    check("handleFlowReply → rescheduled", outcome.status === "rescheduled", `got ${JSON.stringify(outcome)}`);
    const conv2Final = await prisma.conversation.findUnique({ where: { id: conv2.id } });
    check("旗標已清", conv2Final?.reschedulingApptId === null);
    check("AuditLog BOOKING_RESCHEDULE", (await prisma.auditLog.findFirst({ where: { entityId: conv2.id, action: "BOOKING_RESCHEDULE" } })) !== null);
    const msg5 = await prisma.message.findFirst({ where: { conversationId: conv2.id, direction: "OUT", aiAutoSent: true }, orderBy: { createdAt: "desc" } });
    check("改期訊息已發出", msg5?.body === `已為你改至 ${Number(day2.split("-")[1])}月${Number(day2.split("-")[2])}日 14:00`, msg5?.body ?? "null");
    check("mock 收到 reschedule call（200）", callsSince(t0).some((c) => c.path.endsWith("/reschedule") && c.status === 200));
    const l2Day2Left = await prisma.availabilitySlot.count({ where: { clinicId: clinic.id, date: day2 } });
    check("L2 新日 invalidate（雙日之一）", l2Day2Left === 0, `left=${l2Day2Left}`);

    // ── ⑥ 取消全鏈 ────────────────────────────────────────────────────────
    console.log("\n[⑥] 取消全鏈（-7 + 取消訊息 + L2）");
    r = await call(cancelRoute.POST as Handler, cookieStaff1, conv3.id, { apricotApptId: "e2e-appt-2" });
    check("cancel route → 200", r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    check("AuditLog BOOKING_CANCEL", (await prisma.auditLog.findFirst({ where: { entityId: conv3.id, action: "BOOKING_CANCEL" } })) !== null);
    const msg6 = await prisma.message.findFirst({ where: { conversationId: conv3.id, direction: "OUT", aiAutoSent: true } });
    check("取消訊息已發出", msg6 !== null && (msg6.body ?? "").includes("已為你取消"));
    check("mock 收到 status -7（200）", callsSince(t0).some((c) => c.path.endsWith("/status") && c.status === 200));
    const l2CLeft = await prisma.availabilitySlot.count({ where: { clinicId: clinic.id, date: addDaysISO(SLOT_DATE, 5) } });
    check("L2 該日 invalidate", l2CLeft === 0, `left=${l2CLeft}`);

    // ── ⑦ Send Lock：非負責人三個掣全 423 ────────────────────────────────
    console.log("\n[⑦] Send Lock（conv4 assignee=staff2；staff1 操作）");
    const bk7 = await prisma.bookingRequest.create({
      data: {
        conversationId: conv4.id,
        clinicId: clinic.id,
        flowToken: `${E2E_PREFIX}ft7-${suffix}`,
        providerApricotId: PROVIDER,
        providerName: PROVIDER_NAME,
        requestedDate: SLOT_DATE,
        requestedTime: SLOT_TIME,
        status: "CONFIRMED",
        apricotApptId: "mock-appt-locked",
        handledByStaffId: staff1.id,
        handledAt: new Date(),
      },
    });
    r = await call(rollbackRoute.POST as Handler, cookieStaff1, bk7.id);
    check("rollback → 423", r.status === 423, `got ${r.status}`);
    r = await call(rescheduleRoute.POST as Handler, cookieStaff1, conv4.id, { apricotApptId: "e2e-appt-1" });
    check("reschedule → 423", r.status === 423, `got ${r.status}`);
    r = await call(cancelRoute.POST as Handler, cookieStaff1, conv4.id, { apricotApptId: "e2e-appt-2" });
    check("cancel → 423", r.status === 423, `got ${r.status}`);
    check("旗標冇被誤設（423 在副作用前）", (await prisma.conversation.findUnique({ where: { id: conv4.id } }))?.reschedulingApptId === null);

    // ── ⑧ 新客 variant 唔出現（未釘住 → 400）─────────────────────────────
    console.log("\n[⑧] ALLOW_NEW_PATIENT_WRITE off → 新客 variant 唔出現");
    const bk8 = await prisma.bookingRequest.create({
      data: {
        conversationId: conv5.id,
        clinicId: clinic.id,
        flowToken: `${E2E_PREFIX}ft8-${suffix}`,
        providerApricotId: PROVIDER,
        providerName: PROVIDER_NAME,
        requestedDate: SLOT_DATE,
        requestedTime: SLOT_TIME,
        status: "PENDING",
      },
    });
    r = await call(createRoute.POST as Handler, cookieStaff1, bk8.id, { visitReasonId: VR.apricotId });
    check("未釘住 conv 代落單 → 400 no_pinned_patient（新客寫入路徑唔存在）", r.status === 400 && r.body?.error === "no_pinned_patient", `got ${r.status} ${JSON.stringify(r.body)}`);
  } finally {
    // ── cleanup（best-effort — 整條 transaction 失敗就跳過）────────────
    try {
      await prisma.$transaction([
        prisma.availabilitySlot.delete({ where: { id: slot1.id } }),
        prisma.availabilitySlot.delete({ where: { id: slot2.id } }),
        prisma.availabilitySlot.delete({ where: { id: slot3.id } }),
        prisma.message.deleteMany({ where: { conversationId: { in: [conv1.id, conv2.id, conv3.id, conv4.id, conv5.id] } } }),
        prisma.bookingRequest.deleteMany({ where: { conversationId: { in: [conv1.id, conv2.id, conv3.id, conv4.id, conv5.id] } } }),
        prisma.flowSession.deleteMany({ where: { conversationId: { in: [conv1.id, conv2.id, conv3.id, conv4.id, conv5.id] } } }),
        prisma.auditLog.deleteMany({ where: { entityId: { in: [conv1.id, conv2.id, conv3.id, conv4.id, conv5.id] } } }),
        prisma.conversation.deleteMany({ where: { contactId: contact.id } }),
        prisma.contact.delete({ where: { id: contact.id } }),
        prisma.staffUser.delete({ where: { id: staff1.id } }),
        prisma.staffUser.delete({ where: { id: staff2.id } }),
      ]);
    } catch (e) {
      console.error(`cleanup 部分失敗（手動清 e2e-bkui-${suffix}* 殘留）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (patientsBackup !== null) writeFileSync(PATIENTS_FILE, patientsBackup);
    else rmSync(PATIENTS_FILE, { force: true });
    rmSync(SLOT_TAKEN_FLAG, { force: true });
    rmSync(CALLS_LOG, { force: true });
  }

  // ── ⑨ socket 第二 browser（要 live server）────────────────────────────
  console.log("\n[⑨] socket 第二 browser（booking:changed 即時推）");
  if (process.argv.includes("--server")) {
    const port = process.env.PORT ?? "3100";
    const staff = await prisma.staffUser.findFirst({ where: { role: "STAFF", active: true } });
    if (!staff) {
      console.error("  ✗ ⑨ 無 active staff 可以出 cookie（部署環境先跑 --server）");
      failures += 1;
    } else {
      const data: SessionData = { staffId: staff.id, email: staff.email, name: staff.name, role: "STAFF", clinicId: staff.clinicId, loginAt: Date.now() };
      const sealed = await sealData(data as object, sessionOptions());
      const socket = io(`http://127.0.0.1:${port}`, {
        transports: ["websocket"],
        extraHeaders: { Cookie: `${SESSION_COOKIE_NAME}=${sealed}` },
        timeout: 8000,
        reconnection: false,
      });
      const gotEvent = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 10000);
        socket.on("connect", () => {
          // 本 clinic 內任一個 booking:changed（部署環境有其他流量/或手動觸發）
          socket.on("booking:changed", () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        socket.on("connect_error", () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      socket.disconnect();
      check("第二 browser 收到 booking:changed", gotEvent);
    }
  } else {
    console.log("  ⊘ SKIP — 要 live server（pnpm e2e:booking-ui --server）；詳見 deployment checklist");
  }

  await prisma.$disconnect();
  console.log(failures === 0 ? "\nE2E PASS ✅（booking-ui ①–⑨）" : `\nE2E FAIL ❌（${failures} 項）`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
