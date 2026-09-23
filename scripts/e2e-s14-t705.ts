/**
 * e2e-s14-t705 — cwi-final S1-4 T705：跨店 assignee 收 3 事件
 *
 * spec 原文（S1-4 測試 T705）：跨店 assignee 收到 `draft:ready`、`urgent:escalation`、`conv:updated`。
 *
 * 設計（接盤單 #7）：
 *  - 獨立 fixture：company E2ES14C-CO + clinic A（對話所在店）+ clinic B
 *  - STAFF ASG（CLINICS 只綁 B）= 對話 C（ clinic A）嘅 assignee → 跨店指派
 *    （ASG socket 入 clinic:B + staff:ASG room，唔入 clinic:A room）
 *  - 3 事件由本 process 直接 call `publishConvEvent`（接盤單批准：「手動 call publishConvEvent 同 payload」）
 *    → 真 S1-4 targeting（crossClinicTargets：assignee 唔覆蓋 A → staff room 補推）
 *    + 真 S1-7 dev schema.parse（唔過即 throw）+ Redis 橋 → server relay → socket
 *  - eventId 由測試注入（publishConvEvent 保留 payload.eventId）→ 可對返收到嘅係邊個事件
 *
 * 斷言：
 *   B1 ASG socket 收到 draft:ready（恰 1 次，eventId 對返）
 *   B2 ASG socket 收到 urgent:escalation（恰 1 次，eventId 對返）
 *   B3 ASG socket 收到 conv:updated（恰 1 次，eventId 對返）
 *   B4 settle 後三個計數都仍然 === 1（冇重複補推）
 *
 * 前置：dev stack live（server 3100 + DB 15432 + redis 6379；worker 唔影響）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s14-t705.ts
 * 輸出：T705-OK / T705-FAIL: <reason>（exit 1）
 */
import "./e2e-origin-shim";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { io, type Socket } from "socket.io-client";
import { publishConvEvent, convRef } from "@/lib/notify";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const COMPANY_CODE = "E2ES14C-CO";
const CLINIC_A = "E2ES14C-A"; // 對話所在店
const CLINIC_B = "E2ES14C-B"; // assignee 綁定店
const ASG_EMAIL = "e2e-s14c-asg@wa-clinic.local";
const PASS = "e2e-s14c-pass-2026";
const WA_ID = "99081411";
const WA_PREFIX = "990814";
const CONV_ID = "e2es14cconv000000t705a"; // 22 位 lowercase alnum（cuid 形）
const TS = Date.now();

const EV_CONV = `evt-t705-conv-${TS}`;
const EV_DRAFT = `evt-t705-draft-${TS}`;
const EV_URGENT = `evt-t705-urgent-${TS}`;

let FAILS = 0;
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(label);
  else fail(`${label}${detail !== undefined ? `（${JSON.stringify(detail)}）` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" = '${CONV_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code IN ('${CLINIC_A}','${CLINIC_B}'))`);
  await prisma.contact.deleteMany({ where: { waId: { startsWith: WA_PREFIX } } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: ASG_EMAIL } } });
  await prisma.staffUser.deleteMany({ where: { email: ASG_EMAIL } });
  await prisma.clinic.deleteMany({ where: { code: { in: [CLINIC_A, CLINIC_B] } } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function seed(): Promise<{ clinicA: string; asgId: string; contactId: string }> {
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES14C CO" } });
  const ca = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_A, name: "E2ES14C Clinic A", waPhoneNumberId: "E2ES14C-A-PH", waDisplayNumber: "+852 0000 7151" },
  });
  const cb = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_B, name: "E2ES14C Clinic B", waPhoneNumberId: "E2ES14C-B-PH", waDisplayNumber: "+852 0000 7152" },
  });
  const argon2 = (await import("argon2")).default;
  const asg = await prisma.staffUser.create({
    data: { email: ASG_EMAIL, name: "E2E S14C ASG", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(PASS) },
  });
  await prisma.staffClinic.create({ data: { staffId: asg.id, clinicId: cb.id, isPrimary: true } }); // 只綁 B
  const ct = await prisma.contact.create({
    data: { clinicId: ca.id, waId: WA_ID, profileName: "E2ES14C P0001", labels: [] },
  });
  await prisma.conversation.create({
    data: { id: CONV_ID, clinicId: ca.id, contactId: ct.id, status: "OPEN", assigneeId: asg.id, lastMessageAt: new Date(TS - 60_000) },
  });
  return { clinicA: ca.id, asgId: asg.id, contactId: ct.id };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASS }),
  });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 冇 wa_inbox_session cookie");
  return m[1];
}

function connectSocket(cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(BASE, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `wa_inbox_session=${cookie}` },
      timeout: 8000,
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error("socket connect timeout")), 10_000);
    s.on("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(new Error(`socket connect_error: ${err.message}`));
    });
  });
}

interface Cap {
  conv: { n: number; eventIds: string[] };
  draft: { n: number; eventIds: string[] };
  urgent: { n: number; eventIds: string[] };
}

async function main(): Promise<void> {
  console.log(`[T705] S1-4 跨店 assignee 收 3 事件（draft:ready / urgent:escalation / conv:updated）— base=${BASE}`);
  const probe = await fetch(`${BASE}/`).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`T705-ERR server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();
  const fx = await seed();
  const cookie = await login(ASG_EMAIL);

  const s = await connectSocket(cookie);
  const cap: Cap = {
    conv: { n: 0, eventIds: [] },
    draft: { n: 0, eventIds: [] },
    urgent: { n: 0, eventIds: [] },
  };
  s.onAny((event: string, payload: unknown) => {
    const p = (payload ?? {}) as { conversationId?: string; eventId?: string };
    if (p.conversationId !== CONV_ID) return;
    if (event === "conv:updated") {
      cap.conv.n += 1;
      if (p.eventId) cap.conv.eventIds.push(p.eventId);
    } else if (event === "draft:ready") {
      cap.draft.n += 1;
      if (p.eventId) cap.draft.eventIds.push(p.eventId);
    } else if (event === "urgent:escalation") {
      cap.urgent.n += 1;
      if (p.eventId) cap.urgent.eventIds.push(p.eventId);
    }
  });
  await sleep(800); // room join async 窗口

  // ── 3 事件（dev 環境 publishConvEvent 內建 schema.parse — 唔過即 throw）────────
  const ref = convRef({
    id: CONV_ID,
    clinicId: fx.clinicA,
    assigneeId: fx.asgId,
    routedStaffId: null,
    routedGroupId: null,
  });
  await publishConvEvent(ref, "conv:updated", {
    conversationId: CONV_ID,
    clinicId: fx.clinicA,
    assigneeId: fx.asgId,
    assignVersion: 1,
    unreadCount: 2,
    eventId: EV_CONV,
  });
  await publishConvEvent(ref, "draft:ready", {
    conversationId: CONV_ID,
    draftId: `e2es14cdraft000${TS}`,
    inReplyToMessageId: `e2es14cmsg00000${TS}`,
    draftText: "T705 draft 樣本（e2e）",
    model: "e2e-mock-model",
    latencyMs: 12,
    mode: "DRAFT",
    traceJson: null,
    eventId: EV_DRAFT,
  });
  await publishConvEvent(ref, "urgent:escalation", {
    conversationId: CONV_ID,
    intent: "COMPLAINT",
    urgency: "HIGH",
    contactId: fx.contactId,
    contactName: "E2ES14C P0001",
    waMessageId: null,
    eventId: EV_URGENT,
  });

  // 等齊 3 個
  const waitStart = Date.now();
  while ((cap.conv.n < 1 || cap.draft.n < 1 || cap.urgent.n < 1) && Date.now() - waitStart < 15_000) await sleep(100);

  check("B1 draft:ready 收到（恰 1 次，eventId 對返）", cap.draft.n === 1 && cap.draft.eventIds[0] === EV_DRAFT, cap.draft);
  check("B2 urgent:escalation 收到（恰 1 次，eventId 對返）", cap.urgent.n === 1 && cap.urgent.eventIds[0] === EV_URGENT, cap.urgent);
  check("B3 conv:updated 收到（恰 1 次，eventId 對返）", cap.conv.n === 1 && cap.conv.eventIds[0] === EV_CONV, cap.conv);

  await sleep(2000); // settle — 重複補推窗口
  check(
    "B4 settle 後三事件計數都 === 1（零重複）",
    cap.conv.n === 1 && cap.draft.n === 1 && cap.urgent.n === 1,
    { conv: cap.conv.n, draft: cap.draft.n, urgent: cap.urgent.n },
  );

  s.disconnect();
  await cleanup();
  const res = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT (
      (SELECT count(*) FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code IN ('${CLINIC_A}','${CLINIC_B}')))
      + (SELECT count(*) FROM "Contact" WHERE "waId" LIKE '${WA_PREFIX}%')
      + (SELECT count(*) FROM "StaffUser" WHERE email = '${ASG_EMAIL}')
      + (SELECT count(*) FROM "Clinic" WHERE code IN ('${CLINIC_A}','${CLINIC_B}'))
      + (SELECT count(*) FROM "Company" WHERE code = '${COMPANY_CODE}')
    )::int AS n`
  );
  check("cleanup 零殘留", res[0]?.n === 0, `residue=${res[0]?.n}`);

  console.log(FAILS === 0 ? "\nT705-OK（B1-B4 全綠）" : `\nT705-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T705-ERR", e instanceof Error ? e.stack ?? e.message : e);
    process.exit(2);
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch {
      /* ignore */
    }
    await prisma.$disconnect();
  });
