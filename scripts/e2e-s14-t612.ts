/**
 * e2e-s14-t612 — cwi-final S1-4 T612：跨店組路由 + 去重（message:new）
 *
 * spec 原文：X（唔綁 MF）屬服務 MF 嘅組 → MF 路由線收新訊息 → X 嘅 socket 1 秒內收到
 *   `message:new`；同一事件 X 冇收兩次；同店成員 Y 亦只收一次（`socket.onAny` 計數）。
 *
 * 設計（接盤單 #7）：
 *  - 獨立 fixture：company E2ES14H-CO + clinic H（home，X 綁呢間）+ clinic M（訊息落呢間，spec 之「MF」）
 *  - SkillGroup G（code E2ES14H-G）+ SkillGroupClinic(G→M)（「服務 M 嘅組」）
 *  - STAFF X（CLINICS 只綁 H、G 組員、唔綁 M）→ 只經 staff:X room 收（跨店補推）
 *  - STAFF Y（CLINICS 綁 M）→ 只經 clinic:M room 收
 *  - 預建 contact + conversation（routedGroupId=G）→ webhook inbound 由 worker 落庫到同一條 conv
 *    （findOrCreateConversation upsert by clinicId+contactId）→ notifyNewMessage → publishConvEvent
 *
 * 斷言：
 *   A1 X socket 收到 message:new（conversationId=C）且 webhoo POST → 收到 ≤ 1 秒
 *   A2 同一事件 X 冇收兩次（settle 後 onAny 計數 === 1）
 *   A3 同店 Y 只收一次（計數 === 1）
 *   A4 X 同 Y 收到嘅 eventId 同一個（單一事件雙路徑，client 去重前提）
 *   A5 DB：訊息確實落咗 fixture conv（事件來源正確，唔係隔離）
 *
 * 前置：dev stack live（server 3100 + worker + DB 15432 + redis 6379）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s14-t612.ts
 * 輸出：T612-OK / T612-FAIL: <reason>（exit 1）
 */
import "./e2e-origin-shim";
import path from "node:path";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { io, type Socket } from "socket.io-client";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const COMPANY_CODE = "E2ES14H-CO";
const CLINIC_H = "E2ES14H"; // home — X 綁呢間
const CLINIC_M = "E2ES14M"; // 訊息落地店（spec 之 MF）
const GROUP_CODE = "E2ES14H-G";
const X_EMAIL = "e2e-s14x@wa-clinic.local";
const Y_EMAIL = "e2e-s14y@wa-clinic.local";
const PASS = "e2e-s14h-pass-2026";
const WA_ID = "99081401";
const WA_PREFIX = "990814";
const CONV_ID = "e2es14hconv000000t612a"; // 22 位 lowercase alnum（cuid 形）
const TS = Date.now();
const WAMID = `wamid.t612h.${TS}`;

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
const WA_APP_SECRET = process.env.WA_APP_SECRET ?? "";
let clinicM = { waPhoneNumberId: "", waDisplayNumber: null as string | null };

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" = '${CONV_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code IN ('${CLINIC_H}','${CLINIC_M}'))`);
  await prisma.contact.deleteMany({ where: { waId: { startsWith: WA_PREFIX } } });
  await prisma.$executeRawUnsafe(`DELETE FROM "SkillGroupMember" WHERE "groupId" IN (SELECT id FROM "SkillGroup" WHERE code = '${GROUP_CODE}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SkillGroupClinic" WHERE "groupId" IN (SELECT id FROM "SkillGroup" WHERE code = '${GROUP_CODE}')`);
  await prisma.skillGroup.deleteMany({ where: { code: GROUP_CODE } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: { in: [X_EMAIL, Y_EMAIL] } } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: [X_EMAIL, Y_EMAIL] } } });
  await prisma.clinic.deleteMany({ where: { code: { in: [CLINIC_H, CLINIC_M] } } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
  await prisma.webhookEvent.deleteMany({ where: { id: WAMID } });
}

async function seed(): Promise<void> {
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES14H CO" } });
  const ch = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_H, name: "E2ES14H Clinic H", waPhoneNumberId: "E2ES14H-PH", waDisplayNumber: "+852 0000 7141" },
  });
  const cm = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_M, name: "E2ES14M Clinic M", waPhoneNumberId: "E2ES14M-PH", waDisplayNumber: "+852 0000 7142" },
  });
  clinicM = { waPhoneNumberId: cm.waPhoneNumberId, waDisplayNumber: cm.waDisplayNumber };
  const g = await prisma.skillGroup.create({ data: { code: GROUP_CODE, name: "E2ES14H G 組" } });
  await prisma.skillGroupClinic.create({ data: { groupId: g.id, clinicId: cm.id } }); // 組服務 M

  const argon2 = (await import("argon2")).default;
  const x = await prisma.staffUser.create({
    data: { email: X_EMAIL, name: "E2E S14 X", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(PASS) },
  });
  const y = await prisma.staffUser.create({
    data: { email: Y_EMAIL, name: "E2E S14 Y", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(PASS) },
  });
  await prisma.staffClinic.create({ data: { staffId: x.id, clinicId: ch.id, isPrimary: true } }); // X 只綁 H（唔綁 M）
  await prisma.staffClinic.create({ data: { staffId: y.id, clinicId: cm.id, isPrimary: true } }); // Y 綁 M
  await prisma.skillGroupMember.create({ data: { groupId: g.id, staffId: x.id } }); // X 屬 G（服務 M）；Y 唔屬組

  // 預建 contact + conv（routedGroupId=G）— webhook 入嚟 worker upsert 到同一條
  const ct = await prisma.contact.create({
    data: { clinicId: cm.id, waId: WA_ID, profileName: "E2ES14H P0001", labels: [] },
  });
  await prisma.conversation.create({
    data: { id: CONV_ID, clinicId: cm.id, contactId: ct.id, status: "OPEN", routedGroupId: g.id, lastMessageAt: new Date(TS - 60_000) },
  });
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

/** mock inbound webhook（HMAC-SHA256 — 照 e2e-statusrole2-t2.ts） */
async function mockInbound(wamid: string, text: string): Promise<void> {
  const bizNumber = (clinicM.waDisplayNumber ?? "").replace(/\D/g, "");
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: clinicM.waPhoneNumberId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: bizNumber, phone_number_id: clinicM.waPhoneNumberId },
              contacts: [{ profile: { name: "E2ES14H P0001" }, wa_id: WA_ID }],
              messages: [{ from: WA_ID, id: wamid, timestamp: Math.floor(Date.now() / 1000).toString(), type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", WA_APP_SECRET).update(raw).digest("hex");
  const res = await fetch(`${BASE}/api/wa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
  if (res.status !== 200) throw new Error(`webhook ${wamid} → HTTP ${res.status}: ${await res.text().catch(() => "")}`);
}

interface Cap {
  count: number; // message:new 計數（conversationId = CONV_ID）
  eventIds: string[];
  firstAt: number | null;
}
function makeCatcher(): { cap: Cap; attach: (s: Socket) => void } {
  const cap: Cap = { count: 0, eventIds: [], firstAt: null };
  const attach = (s: Socket): void => {
    // spec：socket.onAny 計數
    s.onAny((event: string, payload: unknown) => {
      if (event !== "message:new") return;
      const p = (payload ?? {}) as { conversationId?: string; eventId?: string };
      if (p.conversationId !== CONV_ID) return;
      cap.count += 1;
      if (p.eventId) cap.eventIds.push(p.eventId);
      if (cap.firstAt === null) cap.firstAt = Date.now();
    });
  };
  return { cap, attach };
}

async function main(): Promise<void> {
  console.log(`[T612] S1-4 跨店組路由 + 去重（message:new）— base=${BASE}`);
  const probe = await fetch(`${BASE}/`).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`T612-ERR server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }
  if (!WA_APP_SECRET) {
    console.error("T612-ERR WA_APP_SECRET 唔係（.env 要有）");
    process.exit(2);
  }

  await cleanup();
  await seed();

  const xCookie = await login(X_EMAIL);
  const yCookie = await login(Y_EMAIL);

  const sx = await connectSocket(xCookie);
  const sy = await connectSocket(yCookie);
  const cx = makeCatcher();
  const cy = makeCatcher();
  cx.attach(sx);
  cy.attach(sy);
  await sleep(800); // room join 係 async（resolveSessionScope）— 留窗口

  // ── 發射：webhook inbound → worker → publishConvEvent ──────────────────
  const t0 = Date.now();
  await mockInbound(WAMID, `e2e t612 ping ${TS}`);

  // 等 X 收到（15s timeout 兜底 — 斷言先計較 1s 預算）
  const waitStart = Date.now();
  while (cx.cap.firstAt === null && Date.now() - waitStart < 15_000) await sleep(100);
  const elapsed = cx.cap.firstAt !== null ? cx.cap.firstAt - t0 : -1;

  check("A1 X 收到 message:new（conversationId=fixture conv）", cx.cap.firstAt !== null, `elapsed=${elapsed}`);
  check("A1 X 1 秒內收到（webhook POST → socket）", elapsed >= 0 && elapsed <= 1000, `elapsed=${elapsed}ms`);

  // settle：等齊所有重複推送窗口（staff room + clinic room 兩路徑都應該喺 1 個 tick 內到齊）
  await sleep(2500);

  check("A2 X 冇收兩次（同一事件計數 === 1）", cx.cap.count === 1, { count: cx.cap.count });
  check("A3 同店 Y 只收一次（計數 === 1）", cy.cap.count === 1, { count: cy.cap.count });
  check(
    "A4 X/Y 收到同一 eventId（單一事件雙路徑）",
    cx.cap.eventIds.length === 1 && cy.cap.eventIds.length === 1 && cx.cap.eventIds[0] === cy.cap.eventIds[0],
    { x: cx.cap.eventIds, y: cy.cap.eventIds },
  );

  // A5：訊息確實落咗 fixture conv（事件來源正確）
  const dbMsg = await prisma.$queryRawUnsafe<{ cid: string | null }[]>(
    `SELECT "conversationId" AS cid FROM "Message" WHERE "waMessageId" = '${WAMID}'`
  );
  check("A5 DB 訊息落 fixture conv", dbMsg.length === 1 && dbMsg[0].cid === CONV_ID, dbMsg);

  sx.disconnect();
  sy.disconnect();

  await cleanup();
  const res = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT (
      (SELECT count(*) FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code IN ('${CLINIC_H}','${CLINIC_M}')))
      + (SELECT count(*) FROM "Contact" WHERE "waId" LIKE '${WA_PREFIX}%')
      + (SELECT count(*) FROM "StaffUser" WHERE email IN ('${X_EMAIL}','${Y_EMAIL}'))
      + (SELECT count(*) FROM "SkillGroup" WHERE code = '${GROUP_CODE}')
      + (SELECT count(*) FROM "Clinic" WHERE code IN ('${CLINIC_H}','${CLINIC_M}'))
      + (SELECT count(*) FROM "Company" WHERE code = '${COMPANY_CODE}')
      + (SELECT count(*) FROM "WebhookEvent" WHERE id = '${WAMID}')
    )::int AS n`
  );
  check("cleanup 零殘留", res[0]?.n === 0, `residue=${res[0]?.n}`);

  console.log(FAILS === 0 ? "\nT612-OK（A1-A5 全綠）" : `\nT612-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T612-ERR", e instanceof Error ? e.stack ?? e.message : e);
    process.exit(2);
  })
  .finally(async () => {
    try {
      await cleanup(); // 崩潰後兜底
    } catch {
      /* ignore */
    }
    await prisma.$disconnect();
  });
