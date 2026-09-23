/**
 * e2e-followup-v3.ts — cwi-followup-v3-20260916 驗收（MD §7 T420–T433；T434 迴歸另跑 P2/P3/P4 + unit）
 *
 * 前置：dev server 127.0.0.1:3100（WA_MOCK=1 / AI_MOCK=1 / WORKFORCE_MOCK=1）；Postgres 15432；redis 6379。
 *   worker 唔強制（scan 直接調 engine；T432 spawn 自己個 worker 測 startup 照起；
 *   T430d S0-8 擴充例外 — 要打運行中 worker 驗證 reminder-scan gate）。
 * 跑法：pnpm -s tsx scripts/e2e-followup-v3.ts
 *
 * 決定性：
 *   - 自建 clinic E2EV3（固定 id）隔離 dev DB 噪音；X1 跨店用 MF/YL（seed 已有）。
 *   - mock 動態 fixture（file-backed，symlink → /tmp 避 Next watcher）：
 *     .dev/workforce-mock-clinical.json（visits — T427 跨店 C 類；quotes 空）
 *     .dev/workforce-mock-followup.json（appointments 空 — B1/B2 當輪 EMPTY，控噪音）
 *   - 全過程零 worker：runFollowupScan 直接 in-process 調（cron 零 outbound 斷言 = scan 前後 Message 數不變）。
 *
 * 斷言：
 *   T420 OUTSTANDING_BALANCE 全鏈唔存在（DB enum + schema block + function grep）
 *   T421 餘額 chip「未結餘額」中性色（source regex）
 *   T422 窗口內採用（/api/messages/send + followupTaskId）→ sentVia=AI_ADOPTED 無 cooldown
 *   T423 過窗 template 預覽 + 未審批唔俾發（task 留 SUGGESTED、零 Message）
 *   T424 跳過 SKIPPED(MANUAL) + 7 日 dedup（scan 唔再出）
 *   T425 膠囊計數 === 列表 row 數（ALL / CLINICS / STAFF 三 scope）
 *   T426 六類時效過期 → EXPIRED + 計數減
 *   T427 跨店去重（MF+YL 同病人 → 一個 SUGGESTED，留最近活躍）
 *   T428 A 類 THANKS 唔出 + 兩連 skip 永久停（+ opt-out 優先）
 *   T429 C 類 72h 痛症 → 壓 consult（PAIN_TRIAGE 口徑）+ CG-010 零療程零報價
 *   T430 cron 零 outbound（scan 前後零新 OUT Message；SUGGESTED 唔會自動發）
 *   T431 workforce fail → per-rule DEP_FAIL ×3 + hub 紅字
 *   T432 retention env 唔一致 → 站照開 + purge skipped + Alert HIGH（cwi-final S0-11）
 *   T433 privacy 頁改字（regex：零 Apricot Vita + 新句式）
 *   鐵律：零原始電話（API/DB 掃描）
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
import "./e2e-origin-shim";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

const argon2 = createRequire(path.join(process.cwd(), "package.json"))("argon2");
import { phoneHashes } from "../src/lib/phone-hash";
import { cronQueue } from "../src/lib/queue";

const BASE = "http://127.0.0.1:3100";
const PASS = "V3-E2E-Pass-789!";
const CLINIC_ID = "e2ev3clinic0000000000001";
const CODE = "E2EV3";
const ADMIN_EMAIL = "e2ev3-admin@e2e.local"; // scopeType ALL
const ADMINC_EMAIL = "e2ev3-adminc@e2e.local"; // scopeType CLINICS（E2EV3）
const STAFF_EMAIL = "e2ev3-staff@e2e.local"; // STAFF（E2EV3）
const MOCK_CLINICAL = path.resolve(process.cwd(), ".dev/workforce-mock-clinical.json");
const MOCK_CLINICAL_REAL = "/tmp/e2ev3-clinical-mock.json";
const MOCK_FOLLOWUP = path.resolve(process.cwd(), ".dev/workforce-mock-followup.json");
const MOCK_FOLLOWUP_REAL = "/tmp/e2ev3-followup-mock.json";
const MOCK_FAIL = path.resolve(process.cwd(), ".dev/workforce-mock-fail.json");
const RUN_START = new Date();

let passCount = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passCount++;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
    process.exitCode = 1;
  }
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ★ Next 15 dev loadManifest race（已知 flake — TOOLS.md）：lazy-compile 時偶發 500 HTML error page。
// 判斷：response 唔係 JSON（< 開頭）或 5xx → 重試（最多 3 次，2s backoff）— 唔當 code 回歸。
async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, init);
    const text = await res.text();
    if (res.ok && !text.startsWith("<")) return { status: res.status, body: JSON.parse(text) };
    if (res.status >= 500 || (!res.ok && text.startsWith("<"))) {
      if (attempt < 3) {
        console.log(`  [api flake] ${url} → ${res.status}（loadManifest race？）— 重試 ${attempt}/3`);
        await sleep(2000);
        continue;
      }
    }
    return { status: res.status, body: safeJson(text) };
  }
  throw new Error("unreachable");
}
function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { __htmlError: text.slice(0, 120) };
  }
}

const prisma = new PrismaClient();

// ── 病人/對話矩陣（固定 id — 冪等）─────────────────────────────────────────────
type Fix = { waId: string; cpId: string; contactId: string; convId: string; name: string; clinic?: "E2EV3" | "MF" | "YL" | "TKW" };
const FIX: Record<string, Fix> = {
  // T426 六類時效（直接建 SUGGESTED task — 每 trigger 一條）
  E1: { waId: "93000001", cpId: "cpv3-e1", contactId: "e2ev3c-e1", convId: "e2ev3v-e1", name: "V3 E1 時效B1" },
  E2: { waId: "93000002", cpId: "cpv3-e2", contactId: "e2ev3c-e2", convId: "e2ev3v-e2", name: "V3 E2 時效B2" },
  E3: { waId: "93000003", cpId: "cpv3-e3", contactId: "e2ev3c-e3", convId: "e2ev3v-e3", name: "V3 E3 時效C" },
  E4: { waId: "93000004", cpId: "cpv3-e4", contactId: "e2ev3c-e4", convId: "e2ev3v-e4", name: "V3 E4 時效D" },
  E5: { waId: "93000005", cpId: "cpv3-e5", contactId: "e2ev3c-e5", convId: "e2ev3v-e5", name: "V3 E5 時效E" },
  E6: { waId: "93000006", cpId: "cpv3-e6", contactId: "e2ev3c-e6", convId: "e2ev3v-e6", name: "V3 E6 時效A" },
  // T427 跨店（MF + YL 同病人同 waId — 兩個 Contact；MF 較活躍）
  X1MF: { waId: "93000007", cpId: "cpv3-x1", contactId: "e2ev3c-x1mf", convId: "e2ev3v-x1mf", name: "V3 X1 跨店MF", clinic: "MF" },
  X1YL: { waId: "93000007", cpId: "cpv3-x1", contactId: "e2ev3c-x1yl", convId: "e2ev3v-x1yl", name: "V3 X1 跨店YL", clinic: "YL" },
  // T424 跳過 + dedup｜T428 兩連/THANKS｜opt-out
  S1: { waId: "93000008", cpId: "cpv3-s1", contactId: "e2ev3c-s1", convId: "e2ev3v-s1", name: "V3 S1 跳過dedup" },
  S2: { waId: "93000009", cpId: "cpv3-s2", contactId: "e2ev3c-s2", convId: "e2ev3v-s2", name: "V3 S2 兩連skip" },
  K1: { waId: "93000010", cpId: "cpv3-k1", contactId: "e2ev3c-k1", convId: "e2ev3v-k1", name: "V3 K1 THANKS" },
  O1: { waId: "93000014", cpId: "cpv3-o1", contactId: "e2ev3c-o1", convId: "e2ev3v-o1", name: "V3 O1 opt-out" },
  // T423 過窗未審批｜T422 窗內採用
  W1: { waId: "93000011", cpId: "cpv3-w1", contactId: "e2ev3c-w1", convId: "e2ev3v-w1", name: "V3 W1 過窗未審批" },
  W2: { waId: "93000012", cpId: "cpv3-w2", contactId: "e2ev3c-w2", convId: "e2ev3v-w2", name: "V3 W2 窗內採用" },
  // T429 C 類 72h 痛症（P1 = 窗 + P2 = 對照無窗）
  P1: { waId: "93000013", cpId: "cpv3-p1", contactId: "e2ev3c-p1", convId: "e2ev3v-p1", name: "V3 P1 術後痛" },
  P2: { waId: "93000015", cpId: "cpv3-p2", contactId: "e2ev3c-p2", convId: "e2ev3v-p2", name: "V3 P2 對照" },
  // T425 scope 對照（TKW 店 — ALL 見到、E2EV3 scope 唔見）
  T1: { waId: "93000016", cpId: "cpv3-t1", contactId: "e2ev3c-t1", convId: "e2ev3v-t1", name: "V3 T1 跨scope", clinic: "TKW" },
};
/** T426：六類 trigger → 過期口徑（suggestionExpiryAt）；dueAt 設咗令 expiry 全部喺 1 日前。 */
const TRIGGER_FIX: Record<string, string> = {
  E1: "BEFORE_APPOINTMENT", // expiry = dueAt + 1d（無 apptDate ctx）
  E2: "AFTER_NO_SHOW", // expiry = dueAt + 7d
  E3: "AFTER_TREATMENT", // expiry = dueAt + 3d
  E4: "RECALL_NO_REPEAT", // expiry = dueAt + 14d
  E5: "QUOTED_NOT_BOOKED", // expiry = dueAt + 14d
  E6: "CONVERSATION_IDLE", // expiry = dueAt + 7d
};
/** dueAt 偏移（日）— 令 expiry 落喺 now-1d（B1 特例 -2d：expiry = dueAt+1d）。 */
const DUE_OFFSET: Record<string, number> = { E1: -2, E2: -8, E3: -4, E4: -15, E5: -15, E6: -8 };

function dstr(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const hk = new Date(d.getTime() + 8 * 3_600_000);
  return hk.toISOString().slice(0, 10);
}

// ── PII 守門：零原始電話（HK 8 位 9 字頭 raw phone；hash 係 64-hex 唔會撞）──────────
const RE_RAW_PHONE = /852[2-9]\d{6}|\b9\d{7}\b/;
function assertNoPii(obj: unknown, label: string): void {
  const s = JSON.stringify(obj ?? "");
  const hit = s.match(RE_RAW_PHONE);
  check(`PII 守門：${label} 零原始電話`, !hit, hit ? `命中 ${hit[0]}` : undefined);
}

// ── mock fixture（file-backed — symlink → /tmp 避 watcher）────────────────────────
function mockLink(real: string, link: string): void {
  try {
    fs.unlinkSync(link);
  } catch {
    /* 冇 */
  }
  fs.symlinkSync(real, link);
}

async function main(): Promise<void> {
  // ── 基建 + 冪等洗 ─────────────────────────────────────────────────────────
  console.log("\n[SETUP] 基建 + 冪等洗");
  const pg = spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "15432", "-q"]);
  if (pg.status !== 0) fail("Postgres 15432 唔喺");
  const srv = await fetch(`${BASE}/api/auth/login`, { method: "POST", body: "{}" }).catch(() => null);
  if (!srv) fail("dev server 3100 唔喺");
  void srv;

  const convIds = Object.values(FIX).map((f) => f.convId);
  const contactIds = Object.values(FIX).map((f) => f.contactId);
  const emails = [ADMIN_EMAIL, ADMINC_EMAIL, STAFF_EMAIL];
  const oldStaff = await prisma.staffUser.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const oldTaskIds = (
    await prisma.followupTask.findMany({
      where: { OR: [{ conversationId: { in: convIds } }, { patientApricotId: { startsWith: "cpv3-" } }] },
      select: { id: true },
    })
  ).map((t) => t.id);
  {
    await prisma.followupTask.deleteMany({ where: { OR: [{ conversationId: { in: convIds } }, { patientApricotId: { startsWith: "cpv3-" } }, { createdAt: { gte: RUN_START } }] } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.consultSession.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.painTriageSession.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...convIds, ...oldTaskIds] } }, { action: { startsWith: "FOLLOWUP_" }, createdAt: { gte: RUN_START } }] } });
    if (oldStaff.length) {
      await prisma.staffClinic.deleteMany({ where: { staffId: { in: oldStaff.map((s) => s.id) } } });
      await prisma.staffUser.deleteMany({ where: { id: { in: oldStaff.map((s) => s.id) } } });
    }
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.staffClinic.deleteMany({ where: { clinicId: CLINIC_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    for (const f of [MOCK_CLINICAL_REAL, MOCK_FOLLOWUP_REAL]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* 冇 */
      }
    }
  }
  check("冪等洗完成", true);

  // clinic（E2EV3 自建；MF/YL/TKW 用 seed 店）
  const clinic = await prisma.clinic.upsert({
    where: { id: CLINIC_ID },
    update: { code: CODE, name: "V3 E2E 診所", waDisplayNumber: "+852 3001 9003" },
    create: { id: CLINIC_ID, code: CODE, name: "V3 E2E 診所", waPhoneNumberId: "109990000000099", waDisplayNumber: "+852 3001 9003" },
  });
  const clinicBy = new Map<string, { id: string }>([["E2EV3", clinic]]);
  for (const code of ["MF", "YL", "TKW"]) {
    const c = await prisma.clinic.findFirst({ where: { code } });
    if (!c) fail(`clinic ${code} 搵唔到`);
    clinicBy.set(code, c);
  }

  // users（三 scope：ALL / CLINICS(E2EV3) / STAFF(E2EV3)）
  const pwHash = await argon2.hash(PASS);
  const mkUser = async (id: string, email: string, role: "ADMIN" | "STAFF", scopeType: string) => {
    await prisma.staffUser.upsert({
      where: { email },
      update: { active: true, scopeType: scopeType as never },
      create: { id, email, name: `E2E V3 ${role}`, passwordHash: pwHash, role, active: true, scopeType: scopeType as never },
    });
    const u = (await prisma.staffUser.findUnique({ where: { email } }))!;
    await prisma.staffClinic.deleteMany({ where: { staffId: u.id } });
    if (scopeType === "CLINICS") {
      await prisma.staffClinic.create({ data: { staffId: u.id, clinicId: CLINIC_ID, isPrimary: true } });
    }
    return u;
  };
  await mkUser("e2ev3-admin-u1", ADMIN_EMAIL, "ADMIN", "ALL");
  await mkUser("e2ev3-adminc-u1", ADMINC_EMAIL, "ADMIN", "CLINICS");
  await mkUser("e2ev3-staff-u1", STAFF_EMAIL, "STAFF", "CLINICS");

  const login = async (email: string): Promise<string> => {
    let cookie = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: PASS }),
      });
      if (res.status === 429) {
        console.log(`  [login ${email}] 429 限流 — 等 65s 重試（${attempt}/3）`);
        await sleep(65_000);
        continue;
      }
      const setCookie = res.headers.get("set-cookie") ?? "";
      cookie = setCookie.split(";")[0];
      if (res.ok && cookie.includes("wa_inbox_session")) return cookie;
      fail(`login ${email} 失敗（${res.status}）`);
    }
    fail(`login ${email} 3 次都 429`);
  };
  const cookieAll = await login(ADMIN_EMAIL);
  const cookieClinics = await login(ADMINC_EMAIL);
  const cookieStaff = await login(STAFF_EMAIL);
  check("SETUP 三 scope 用戶登入（ALL / CLINICS / STAFF）", true);
  const H = { "Content-Type": "application/json" };

  // fixture：contact + conversation（每條對話 lastInboundAt 按測試矩陣）
  const mkConv = (k: string, lastInboundHrsAgo: number | null, extra?: Record<string, unknown>) => {
    const f = FIX[k];
    const clinicRow = clinicBy.get(f.clinic ?? "E2EV3")!;
    return prisma.contact
      .upsert({
        where: { id: f.contactId },
        update: { clinicId: clinicRow.id, profileName: f.name, followupOptOut: false, optOutAt: null, optOutSource: null },
        create: { id: f.contactId, clinicId: clinicRow.id, waId: f.waId, profileName: f.name, labels: [] },
      })
      .then(async (ct) => {
        const data = {
          contactId: ct.id,
          clinicId: clinicRow.id,
          status: "OPEN" as const,
          assigneeId: null,
          lastInboundAt: lastInboundHrsAgo === null ? null : new Date(Date.now() - lastInboundHrsAgo * 3_600_000),
          lastMessageAt: new Date(Date.now() - (lastInboundHrsAgo ?? 24 * 30) * 3_600_000),
          ...extra,
        };
        await prisma.conversation.upsert({ where: { id: f.convId }, update: data, create: { id: f.convId, ...data } });
      });
  };
  const convPlan: [string, number | null][] = [
    ["E1", 24], ["E2", 24], ["E3", 24], ["E4", 24], ["E5", 24], ["E6", 24], // 1 日（A 唔候選 — 純時效 fixture）
    ["X1MF", 1], // MF 較活躍（T427 留 MF）
    ["X1YL", 3], // YL 較舊
    ["S1", 240], ["S2", 240], ["K1", 240], ["O1", 240], // 10 日（A 候選）
    ["W1", 72], // 3 日（24h 窗關；<7 日 A 唔候選）
    ["W2", 1], ["P1", 1], ["P2", 1], // 1 小時（窗開）
    ["T1", 24], // 1 日（A 唔候選；純 scope fixture）
  ];
  await Promise.all(convPlan.map(([k, h]) => mkConv(k, h)));
  await prisma.conversation.update({ where: { id: FIX.K1.convId }, data: { intent: "THANKS" } }); // T428a
  await prisma.conversation.update({ where: { id: FIX.S1.convId }, data: { pinnedPatientApricotId: "cpv3-s1" } }); // T424b：pin patient → patient 層 7 日 dedup window 生效
  await prisma.contact.update({ where: { id: FIX.O1.contactId }, data: { followupOptOut: true, optOutAt: new Date(), optOutSource: "manual" } }); // opt-out

  // 出廠規則（seed 6 條 — F 已剷）
  const ruleIds: Record<string, string> = {};
  // ★ cwi-final S2-1（S0-8 ⑦）：B1 出廠規則已永久 disable（firstUseConfirmedAt NULL）→ 只驗存在、唔要求 enabled
  {
    const b1 = await prisma.followupRule.findFirst({ where: { trigger: "BEFORE_APPOINTMENT" as never } });
    if (!b1) fail("出廠規則 BEFORE_APPOINTMENT 搵唔到（seed？）");
    ruleIds["BEFORE_APPOINTMENT"] = b1.id;
  }
  for (const trig of ["CONVERSATION_IDLE", "AFTER_NO_SHOW", "AFTER_TREATMENT", "RECALL_NO_REPEAT", "QUOTED_NOT_BOOKED"]) {
    const r = await prisma.followupRule.findFirst({ where: { trigger: trig as never, enabled: true } });
    if (!r) fail(`出廠規則 ${trig} 搵唔到（seed？）`);
    ruleIds[trig] = r.id;
  }
  check("SETUP 規則矩陣（5 條 enabled + B1 存在 — S0-8 disable）", true);

  // mock fixture（clinical：X1 跨店 visits；followup：appointments 空）
  const d = dstr(-2);
  const xHashes = phoneHashes(FIX.X1MF.waId);
  fs.writeFileSync(
    MOCK_CLINICAL_REAL,
    JSON.stringify(
      {
        visits: [
          { patientCode: "PCV3", clinicCode: "MF", providerCode: "provv3", hasNote: false, noteKind: "STANDARD", firstLine: "E2E mock（零真值）", quotedItems: null, billTtlAmt: 0, billOsAmt: 0, visitId: "v3x-mf", patientApricotId: "cpv3-x1", visitDate: d, visitReasonCodes: ["0017"], bookingStatus: 1, phoneHashes: xHashes, rxCodes: [{ code: "AMOX", name: "Amoxicillin", isAntibiotic: true }] },
          { patientCode: "PCV3", clinicCode: "YL", providerCode: "provv3", hasNote: false, noteKind: "STANDARD", firstLine: "E2E mock（零真值）", quotedItems: null, billTtlAmt: 0, billOsAmt: 0, visitId: "v3x-yl", patientApricotId: "cpv3-x1", visitDate: d, visitReasonCodes: ["0017"], bookingStatus: 1, phoneHashes: xHashes, rxCodes: [{ code: "AMOX", name: "Amoxicillin", isAntibiotic: true }] },
        ],
        quotes: [],
        terms: [],
        indexStatus: { lastNightly: null, phoneNormalize: { total: 10, withHash: 10, rate: 1.0 } },
      },
      null,
      2
    )
  );
  fs.writeFileSync(MOCK_FOLLOWUP_REAL, JSON.stringify({ appointments: [], balances: {} }, null, 2));
  mockLink(MOCK_CLINICAL_REAL, MOCK_CLINICAL);
  mockLink(MOCK_FOLLOWUP_REAL, MOCK_FOLLOWUP);
  check("SETUP mock fixture（clinical visits ×2 跨店 / appointments 空）", true);

  // 直接建 SUGGESTED task 嘅 helper（bypass scan — 時效/窗口/採用測試用）
  const mkTask = async (k: string, trig: string, dueOffsetHrs: number, ctx?: Record<string, unknown>) => {
    const f = FIX[k];
    const clinicRow = clinicBy.get(f.clinic ?? "E2EV3")!;
    const t = await prisma.followupTask.create({
      data: {
        clinicId: clinicRow.id,
        conversationId: f.convId,
        patientApricotId: f.cpId,
        phoneHashes: phoneHashes(f.waId),
        ruleId: ruleIds[trig],
        source: "RULE",
        dueAt: new Date(Date.now() + dueOffsetHrs * 3_600_000),
        status: "SUGGESTED",
        templateName: trig === "AFTER_TREATMENT" ? "post_op_check" : "conversation_followup",
        contextJson: (ctx ?? null) as never,
      },
    });
    return t;
  };

  // ── T420：OUTSTANDING_BALANCE 全鏈唔存在 ──────────────────────────────────
  console.log("\n[T420] OUTSTANDING_BALANCE 剷除（enum/函數/seed/UI）");
  const dbTrig = await prisma.$queryRawUnsafe<Array<{ agg: string | null }>>(
    "SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS agg FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'FollowupTrigger'"
  );
  const trigList: string = dbTrig[0]?.agg ?? "";
  check("T420a DB FollowupTrigger enum 冇 OUTSTANDING_BALANCE", !trigList.includes("OUTSTANDING_BALANCE"), trigList);
  const schemaSrc = fs.readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
  const enumBlock = schemaSrc.match(/enum FollowupTrigger \{[\s\S]*?\}/)?.[0] ?? "";
  check("T420b schema.prisma FollowupTrigger block 冇 OUTSTANDING_BALANCE", !enumBlock.includes("OUTSTANDING_BALANCE"), enumBlock.slice(0, 120));
  const fnGrep = spawnSync("grep", ["-rn", "scanOutstandingBalance(", "src", "--include=*.ts"], { encoding: "utf8" });
  check("T420c 無 scanOutstandingBalance 函數/調用（code — 註釋不計）", (fnGrep.stdout ?? "").trim() === "", fnGrep.stdout?.slice(0, 200));
  // UI：無 F 類選項（註釋不計 — 前 CTO 留咗「剷走」紀錄註釋係有意義文件）
  const uiGrep = spawnSync("bash", ["-c", 'grep -rn "欠款提醒" src/app src/components 2>/dev/null | grep -vE ":[0-9]+:\\s*(\\*|//|/\\*)" || true'], { encoding: "utf8" });
  check("T420d UI 無「欠款提醒」選項（註釋不計）", (uiGrep.stdout ?? "").trim() === "", uiGrep.stdout?.slice(0, 200));

  // ── T421：餘額 chip「未結餘額」中性色 ─────────────────────────────────────
  console.log("\n[T421] 餘額 chip 文案 + 中性色");
  const checkChipFile = (rel: string) => {
    const src = fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
    const hit = src.split("\n").find((l) => l.includes("未結餘額"));
    const block = hit ? src.slice(Math.max(0, src.indexOf(hit) - 400), src.indexOf(hit) + 400) : "";
    const neutral = /未結餘額/.test(block) && !/text-(red|rose|amber|orange)/.test(block);
    const noOld = !block.includes(">欠款</span>") && !/text-(red|rose|amber|orange)[^>]*>欠款/.test(src);
    return { has: !!hit, neutral, noOld };
  };
  for (const f of ["src/components/inbox/patient-record-panel.tsx", "src/components/inbox/chat-pane.tsx"]) {
    const r = checkChipFile(f);
    check(`T421 ${f.split("/").pop()}：「未結餘額」+ 中性色 + 舊「欠款」警示詞已改`, r.has && r.neutral && r.noOld, r);
  }

  // ── T423：過窗 template 預覽 + 未審批唔俾發（先做 — W1 之後唔郁）──────────
  console.log("\n[T423] 過窗 template 預覽 + 未審批 gate");
  const tW1 = await mkTask("W1", "CONVERSATION_IDLE", -1);
  {
    // ★ conversationId 精確 lock — dev DB 有舊 e2e 殘留 SUGGESTED（63 條）會擠爆 take=50 全域列表
    const res = await fetch(`${BASE}/api/followups/tasks?conversationId=${FIX.W1.convId}`, { headers: { ...H, Cookie: cookieAll } });
    const body = (await res.json()) as any;
    const row = body.tasks?.find((t: any) => t.id === tW1.id);
    check("T423a 過窗建議卡有 template 預覽（變數已填）+ templateApproved=false", !!row && typeof row.templatePreview === "string" && row.templatePreview.length > 0 && row.templateApproved === false, row);
    assertNoPii(row, "T423 建議卡 row");
  }
  {
    const res = await fetch(`${BASE}/api/followups/tasks/${tW1.id}`, { method: "POST", headers: { ...H, Cookie: cookieAll }, body: JSON.stringify({ action: "send" }) });
    const body = (await res.json()) as any;
    const after = await prisma.followupTask.findUnique({ where: { id: tW1.id }, select: { status: true, sentMessageId: true } });
    const msgCount = await prisma.message.count({ where: { conversationId: FIX.W1.convId } });
    check("T423b 未審批 template 唔俾發（task 留 SUGGESTED、零 Message）", body.result?.status === "SKIPPED" && body.result?.cancelReason === "NO_TEMPLATE" && after?.status === "SUGGESTED" && msgCount === 0, { body, after, msgCount });
  }

  // ── T422：窗口內採用 → AI_ADOPTED 無 cooldown ─────────────────────────────
  console.log("\n[T422] 窗口內採用（composer 發送 + followupTaskId claim）");
  const tW2 = await mkTask("W2", "CONVERSATION_IDLE", -1);
  {
    const res = await fetch(`${BASE}/api/messages/send`, {
      method: "POST",
      headers: { ...H, Cookie: cookieAll },
      body: JSON.stringify({ conversationId: FIX.W2.convId, body: "您好，多日前有問過牙患，而家可以約時間睇返。", source: "adopted", followupTaskId: tW2.id }),
    });
    const body = (await res.json()) as any;
    const msg = await prisma.message.findFirst({ where: { conversationId: FIX.W2.convId, direction: "OUT" }, orderBy: { createdAt: "desc" }, select: { id: true, sentVia: true, aiAutoSent: true, billingCategory: true, status: true } });
    const after = await prisma.followupTask.findUnique({ where: { id: tW2.id }, select: { status: true, sentMessageId: true } });
    check("T422a 採用發送成功 + Message.sentVia=AI_ADOPTED（aiAutoSent=false、SERVICE 計費）", res.ok && msg?.sentVia === "AI_ADOPTED" && msg?.aiAutoSent === false && msg?.billingCategory === "SERVICE", { status: res.status, msg });
    check("T422b task 被 claim 做 SENT（sentMessageId 挂住）", after?.status === "SENT" && after?.sentMessageId === msg?.id, after);
    check("T422c 唔觸發 human cooldown（sentVia ≠ HUMAN_TYPED）", msg?.sentVia !== "HUMAN_TYPED", msg?.sentVia);
  }

  // ── T429a：C 類採用發送 → postOpFollowupAt 72h 窗口開 ──────────────────────
  console.log("\n[T429a] C 類發送 → 72h 術後關懷窗");
  const tP1 = await mkTask("P1", "AFTER_TREATMENT", -1, { visitDate: dstr(-2) });
  {
    const res = await fetch(`${BASE}/api/followups/tasks/${tP1.id}`, { method: "POST", headers: { ...H, Cookie: cookieAll }, body: JSON.stringify({ action: "send" }) });
    const body = (await res.json()) as any;
    const after = await prisma.followupTask.findUnique({ where: { id: tP1.id }, select: { status: true, sentMessageId: true } });
    const conv = await prisma.conversation.findUnique({ where: { id: FIX.P1.convId }, select: { postOpFollowupAt: true } });
    const msg = await prisma.message.findFirst({ where: { conversationId: FIX.P1.convId, direction: "OUT" }, orderBy: { createdAt: "desc" }, select: { sentVia: true } });
    check("T429a C 類建議採用 → SENT + AI_ADOPTED", res.ok && body.result?.status === "SENT" && after?.status === "SENT" && msg?.sentVia === "AI_ADOPTED", { body, after, msg });
    const within = !!conv?.postOpFollowupAt && Date.now() - conv.postOpFollowupAt.getTime() < 3_600_000;
    check("T429a conv.postOpFollowupAt 已開（72h 窗口起點）", within, conv?.postOpFollowupAt);
  }

  // ── T429b：72h 窗內痛症 → 壓 consult（PAIN_TRIAGE 口徑）+ CG-010 ──────────
  console.log("\n[T429b] 72h 窗內痛症：PAIN + consult 壓（對照無窗）+ CG-010");
  {
    const { runInboundAi, livePersistPort, buildAiContext } = await import("../src/lib/ai/pipeline");
    const clinicRow = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicBy.get("E2EV3")!.id } });
    const runCase = async (k: "P1" | "P2") => {
      const f = FIX[k];
      const trigMsg = await prisma.message.create({
        data: { conversationId: f.convId, direction: "IN", channel: "API", type: "text", body: "牙痛，想問吓植牙，有冇辦法處理？", status: "SENT", waTimestamp: new Date(), waMessageId: `wamid.e2ev3.${k.toLowerCase()}.trig` },
      });
      await prisma.conversation.update({ where: { id: f.convId }, data: { lastInboundAt: trigMsg.waTimestamp, lastMessageAt: trigMsg.waTimestamp } });
      const convRow = await prisma.conversation.findUniqueOrThrow({ where: { id: f.convId } });
      const ct = await prisma.contact.findUniqueOrThrow({ where: { id: f.contactId } });
      const now = Date.now();
      const ctxMessages = buildAiContext([
        { dir: "OUT", body: "多保重，有咩不舒服隨時話我知。", ts: new Date(now - 7_200_000), type: "text", channel: "API" },
        { dir: "IN", body: "收到，多謝。", ts: new Date(now - 3_600_000), type: "text", channel: "API" },
        { dir: "IN", body: trigMsg.body, ts: trigMsg.waTimestamp as Date, type: "text", channel: "API" },
      ]);
      return runInboundAi({
        clinic: clinicRow,
        msg: { id: trigMsg.id, type: "text", body: trigMsg.body, waMessageId: trigMsg.waMessageId },
        conv: convRow as never,
        contact: { profileName: ct.profileName, waId: ct.waId },
        ctxMessages,
        isMedia: false,
        persist: livePersistPort({ jobAttemptsMade: 0, jobAttemptsTotal: 3, wamid: trigMsg.waMessageId!, clinicId: clinicRow.id, clinicCode: clinicRow.code }),
      });
    };
    const win = await runCase("P1");
    check("T429b 窗內痛症訊息 → intent=PAIN + 唔係急症紅旗", win.result.intent === "PAIN" && win.urgent === false, { intent: win.result.intent, urgent: win.urgent });
    check("T429b 窗內痛症 → consultTrigger 被壓（強行走 PAIN_TRIAGE 唔入 CONSULT）", win.consultTrigger === null, win.consultTrigger);
    const ctrl = await runCase("P2");
    check("T429b 對照（無 72h 窗）：同句訊息 consultTrigger=IMPLANT_CONSULT（壓制係窗口引起）", ctrl.consultTrigger === "IMPLANT_CONSULT" && ctrl.result.intent === "PAIN", { intent: ctrl.result.intent, trigger: ctrl.consultTrigger });
    const cs = await prisma.consultSession.findMany({ where: { conversationId: { in: [FIX.P1.convId, FIX.P2.convId] } }, select: { conversationId: true, workflow: true } });
    check("T429b 窗內對話零 CONSULT session（對照有）", !cs.some((s) => s.conversationId === FIX.P1.convId) && cs.some((s) => s.conversationId === FIX.P2.convId && s.workflow === "IMPLANT_CONSULT"), cs);
    // CG-010 unit（術後窗內草稿零療程零報價）
    const { runClaimGuard } = await import("../src/lib/ai/claim-guard");
    const draft = "術後康復得唔好？建議你做個療程，報價$3800。";
    const g1 = runClaimGuard({ draft, products: [], hasBackendSlot: false, priceDoc: null, postOpCareWindow: true });
    const g2 = runClaimGuard({ draft, products: [], hasBackendSlot: false, priceDoc: null, postOpCareWindow: false });
    check("T429b CG-010：72h 窗內療程/報價草稿被 block", g1.blocked === true && g1.codes.includes("CG-010"), { blocked: g1.blocked, codes: g1.codes });
    check("T429b CG-010：窗外唔啟用呢規則（口徑隔離）", !g2.codes.includes("CG-010"), { codes: g2.codes });
    // 痛症 mock 草稿 = null（結構性零療程零報價）
    check("T429b PAIN intent 無 AI 草稿（draft=null — 零療程零報價 by construction）", win.result.draft === null || win.result.draft === undefined, { hasDraft: !!win.result.draft });
  }

  // ── T424：跳過 SKIPPED(MANUAL)（scan 前做，scan 斷言 dedup）────────────────
  console.log("\n[T424] 跳過 → SKIPPED(MANUAL)（7 日 dedup 喺 scan 斷言）");
  const tS1 = await mkTask("S1", "CONVERSATION_IDLE", -1);
  {
    const res = await fetch(`${BASE}/api/followups/tasks/${tS1.id}`, { method: "POST", headers: { ...H, Cookie: cookieAll }, body: JSON.stringify({ action: "skip" }) });
    const body = (await res.json()) as any;
    const after = await prisma.followupTask.findUnique({ where: { id: tS1.id }, select: { status: true, cancelReason: true, handledBy: true } });
    check("T424a API 跳過 → SKIPPED(MANUAL)", res.ok && body.result?.status === "SKIPPED" && after?.status === "SKIPPED" && after?.cancelReason === "MANUAL", { body, after });
  }

  // ── T428 prep：S2 兩連 skip ───────────────────────────────────────────────
  console.log("\n[T428] A 類防呆（THANKS / 兩連 skip / opt-out — scan 斷言）");
  const tS2a = await mkTask("S2", "CONVERSATION_IDLE", -1);
  const tS2b = await mkTask("S2", "CONVERSATION_IDLE", -1);
  for (const t of [tS2a, tS2b]) {
    const res = await fetch(`${BASE}/api/followups/tasks/${t.id}`, { method: "POST", headers: { ...H, Cookie: cookieAll }, body: JSON.stringify({ action: "skip" }) });
    const after = await prisma.followupTask.findUnique({ where: { id: t.id }, select: { status: true } });
    if (!(res.ok && after?.status === "SKIPPED")) fail(`S2 skip 失敗（${res.status}）`);
  }
  check("T428 prep：S2 兩條 A 類建議連續 skip", true);

  // ── T427+T428+T424+T430：全規則 scan #1 ───────────────────────────────────
  console.log("\n[SCAN#1] 全規則 runFollowupScan（T427 跨店 / T428 防呆 / T424 dedup / T430 零 outbound）");
  const { runFollowupScan } = await import("../src/lib/followup/engine");
  const msgCountBefore = await prisma.message.count({ where: { conversationId: { in: convIds } } });
  await mkTask("T1", "CONVERSATION_IDLE", -1); // T425 scope 對照（scan 前建）
  const scan1 = await runFollowupScan();
  console.log(`  scan1 counters: ${JSON.stringify(scan1)}`);

  // T427 跨店去重
  const x1tasks = await prisma.followupTask.findMany({ where: { patientApricotId: "cpv3-x1" }, select: { id: true, status: true, conversationId: true, clinicId: true, cancelReason: true } });
  const x1sugg = x1tasks.filter((t) => t.status === "SUGGESTED");
  check("T427a 跨店去重：同病人 MF+YL 只出一個 SUGGESTED", x1sugg.length === 1, x1tasks);
  check("T427b 留下最近活躍對話（MF）", x1sugg[0]?.conversationId === FIX.X1MF.convId, x1sugg[0]);
  check("T427c scan dedupCross 計數 >= 1（另一邊被去重）", scan1.dedupCross >= 1, scan1.dedupCross);
  // T428 防呆
  const s1new = await prisma.followupTask.count({ where: { conversationId: FIX.S1.convId, status: "SUGGESTED", createdAt: { gte: RUN_START } } });
  check("T424b 7 日 dedup：跳過後 scan 唔再出（dedupWindow 計數）", s1new === 0 && scan1.dedupWindow >= 1, { s1new, dedupWindow: scan1.dedupWindow });
  const s2new = await prisma.followupTask.count({ where: { conversationId: FIX.S2.convId, status: "SUGGESTED", createdAt: { gte: RUN_START } } });
  check("T428a 兩連 skip → 永久停（aTwoStrike）", s2new === 0 && scan1.aTwoStrike >= 1, { s2new, aTwoStrike: scan1.aTwoStrike });
  const k1new = await prisma.followupTask.count({ where: { conversationId: FIX.K1.convId, status: "SUGGESTED", createdAt: { gte: RUN_START } } });
  check("T428b 最後 intent=THANKS → 唔出（aIntentClose）", k1new === 0 && scan1.aIntentClose >= 1, { k1new, aIntentClose: scan1.aIntentClose });
  const o1new = await prisma.followupTask.count({ where: { conversationId: FIX.O1.convId, status: "SUGGESTED", createdAt: { gte: RUN_START } } });
  check("T428c opt-out 永遠優先（optOut 計數、零 task）", o1new === 0 && scan1.optOut >= 1, { o1new, optOut: scan1.optOut });
  // T430 cron 零 outbound
  const msgCountAfter = await prisma.message.count({ where: { conversationId: { in: convIds } } });
  check("T430a scan 零 outbound：fixture 對話零新 Message", msgCountAfter === msgCountBefore, { before: msgCountBefore, after: msgCountAfter });
  const w1Still = await prisma.followupTask.findUnique({ where: { id: tW1.id }, select: { status: true } });
  const w1msgs = await prisma.message.count({ where: { conversationId: FIX.W1.convId } });
  check("T430b SUGGESTED 唔會自動發（W1 過窗建議 scan 後照係 SUGGESTED、零 Message）", w1Still?.status === "SUGGESTED" && w1msgs === 0, { w1Still, w1msgs });
  // 靜態：engine 入面 Message 建立只喺 sendFollowupTask（UI 觸發）
  const engineSrc = fs.readFileSync(path.resolve(process.cwd(), "src/lib/followup/engine.ts"), "utf8");
  const msgCreates = engineSrc.split("prisma.message.create").length - 1;
  const lazyEnq = engineSrc.split("await lazyEnqueue(").length - 1;
  check("T430c engine 靜態：prisma.message.create ×1 + await lazyEnqueue( ×1（全部喺 sendFollowupTask）", msgCreates === 1 && lazyEnq === 1, { msgCreates, lazyEnq });
  // T430d（★ cwi-final S0-8）：legacy reminder-scan gate — 窗口內 CONFIRMED 單都唔發（REMINDER_AUTO_SEND off → skipped）
  {
    const BR_ID = "e2ev3t430br000000001";
    // now+24h 嘅 HK wall-clock（同 reminder.ts dayStrs 口徑：UTC+8）— 必落 23–25h 窗口
    const hk = new Date(Date.now() + 24 * 3_600_000 + 8 * 3_600_000);
    const reqDate = hk.toISOString().slice(0, 10);
    const reqTime = `${String(hk.getUTCHours()).padStart(2, "0")}:${String(hk.getUTCMinutes()).padStart(2, "0")}`;
    await prisma.bookingRequest.deleteMany({ where: { id: BR_ID } });
    await prisma.bookingRequest.create({
      data: {
        id: BR_ID,
        conversationId: FIX.W1.convId,
        clinicId: CLINIC_ID,
        flowToken: "e2ev3-t430d-flow",
        providerApricotId: "mock-pract-E2EV3-1",
        providerName: "V3 E2E 醫生",
        requestedDate: reqDate,
        requestedTime: reqTime,
        status: "CONFIRMED",
        apricotApptId: "e2ev3-t430d-appt",
      },
    });
    const workerUp = spawnSync("pgrep", ["-f", "[w]orkers/index.ts"], { encoding: "utf8" }).stdout.trim() !== "";
    check("T430d worker 運行中（S0-8 gate 驗證需要）", workerUp);
    if (workerUp) {
      const logPath = "/tmp/wa-worker-dev.log";
      const logSizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      const outBefore = await prisma.message.count({ where: { conversationId: { in: convIds }, direction: "OUT" } });
      // 直接 enqueue 同 shared cron queue — job return value 做主斷言（log flush 可延遲，只做輔助）
      const t430dJob = await cronQueue.add("reminder-scan", {});
      let t430dState = "waiting";
      let t430dRet: unknown = null;
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        t430dState = await t430dJob.getState();
        if (t430dState === "completed" || t430dState === "failed") {
          const fresh = await cronQueue.getJob(t430dJob.id as string); // 重讀 — job 例上嘅 returnvalue 未必已同步
          t430dRet = fresh?.returnvalue ?? t430dJob.returnvalue;
          break;
        }
      }
      let t430dSkipLog = false;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        try {
          if (fs.readFileSync(logPath).subarray(logSizeBefore).toString("utf8").includes("reminder-scan skipped")) {
            t430dSkipLog = true;
            break;
          }
        } catch {
          /* log 未寫到 */
        }
      }
      const outAfter = await prisma.message.count({ where: { conversationId: { in: convIds }, direction: "OUT" } });
      const brAfter = await prisma.bookingRequest.findUnique({ where: { id: BR_ID }, select: { remindedAt: true } });
      check("T430d job 回 skipped（REMINDER_AUTO_SEND off — D-1）", t430dState === "completed" && (t430dRet as any)?.skipped === "REMINDER_AUTO_SEND off", { t430dState, t430dRet });
      check("T430d gate log：worker 回 skipped（零產出必 log）", t430dSkipLog);
      check("T430d outbound 數不變（窗口內 CONFIRMED 單都唔發）", outAfter === outBefore, { outBefore, outAfter });
      check("T430d remindedAt 仍 null（零提醒）", brAfter?.remindedAt === null, brAfter);
    }
    await prisma.bookingRequest.deleteMany({ where: { id: BR_ID } });
  }
  // A-1 留痕
  const ruleAfter = await prisma.followupRule.findUnique({ where: { id: ruleIds["AFTER_TREATMENT"] }, select: { lastScanAt: true, lastScanResult: true } });
  check("T431 prep A-1 留痕：rule.lastScanAt/lastScanResult 已寫", !!ruleAfter?.lastScanAt && ["OK", "EMPTY", "DEP_FAIL"].includes(ruleAfter?.lastScanResult ?? ""), ruleAfter);

  // ── T425：膠囊計數 === 列表 row 數（三 scope）─────────────────────────────
  console.log("\n[T425] 膠囊計數不變式（ALL / CLINICS / STAFF）");
  const capsule = async (cookie: string) => {
    const res = await fetch(`${BASE}/api/conversations?assigned=followup&counts=1`, { headers: { ...H, Cookie: cookie } });
    const body = (await res.json()) as any;
    return { ok: res.ok, count: body?.counts?.followup as number, rows: (body?.items ?? []) as any[] };
  };
  const inv = (label: string, c: { ok: boolean; count: number; rows: any[] }) => {
    check(`T425 ${label}：膠囊計數(${c.count}) === 列表 row 數(${c.rows.length})`, c.ok && c.count === c.rows.length && c.rows.every((r) => !!r.followupDueAt), { count: c.count, rows: c.rows.length });
    return c;
  };
  const cAll = inv("ALL scope", await capsule(cookieAll));
  const cClin = inv("CLINICS(E2EV3) scope", await capsule(cookieClinics));
  const cStaff = inv("STAFF(E2EV3) scope", await capsule(cookieStaff));
  check("T425 scope 隔離：TKW 對話入 ALL 列表、唔入 E2EV3 受限列表", cAll.rows.some((r) => r.id === FIX.T1.convId) && !cClin.rows.some((r) => r.id === FIX.T1.convId) && !cStaff.rows.some((r) => r.id === FIX.T1.convId), { all: cAll.rows.map((r) => r.id), clin: cClin.rows.map((r) => r.id) });

  // ── T426：六類時效 → EXPIRED + 計數減 ─────────────────────────────────────
  console.log("\n[T426] 六類時效過期 → EXPIRED");
  for (const [k, trig] of Object.entries(TRIGGER_FIX)) {
    await mkTask(k, trig, DUE_OFFSET[k] * 24);
  }
  const capBefore = await capsule(cookieAll);
  const scan2 = await runFollowupScan();
  const eConvs = [FIX.E1.convId, FIX.E2.convId, FIX.E3.convId, FIX.E4.convId, FIX.E5.convId, FIX.E6.convId];
  const expiredRows = await prisma.followupTask.findMany({ where: { conversationId: { in: eConvs } }, select: { id: true, status: true } });
  const allExpired = expiredRows.length === 6 && expiredRows.every((t) => t.status === "EXPIRED");
  check("T426a 六類過期建議全部 → EXPIRED", allExpired, expiredRows);
  check("T426b scan expired 計數 = 6", scan2.expired === 6, scan2.expired);
  const capAfter = await capsule(cookieAll);
  check("T426c 膠囊計數減一（−6）", capAfter.count === capBefore.count - 6, { before: capBefore.count, after: capAfter.count });

  // ── T431：workforce fail → DEP_FAIL ×3 + hub 紅字 ─────────────────────────
  console.log("\n[T431] workforce 依賴失敗：留痕 + 3 連 DEP_FAIL hub 紅");
  {
    let logs = "";
    const oWrite = process.stdout.write.bind(process.stdout);
    const eWrite = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = ((chunk: any, ...a: any[]) => { logs += String(chunk); return oWrite(chunk, ...a); }) as never;
    (process.stderr as any).write = ((chunk: any, ...a: any[]) => { logs += String(chunk); return eWrite(chunk, ...a); }) as never;
    try {
      process.env.WORKFORCE_MOCK_FAIL = "1";
      for (let i = 0; i < 3; i++) {
        await runFollowupScan();
        await sleep(50);
      }
    } finally {
      delete process.env.WORKFORCE_MOCK_FAIL;
      (process.stdout as any).write = oWrite;
      (process.stderr as any).write = eWrite;
    }
    console.log(`  [T431 log 捕獲 ${logs.length} chars] ${/rule scan failed|workforce 依賴唔通/.test(logs) ? "命中失敗留痕 log" : "（log 未捕獲 — 以 DB 留痕為準）"}`);
    const cRule = await prisma.followupRule.findUnique({ where: { id: ruleIds["AFTER_TREATMENT"] }, select: { lastScanResult: true } });
    const audits = await prisma.auditLog.findMany({ where: { action: "FOLLOWUP_SCAN", entityId: ruleIds["AFTER_TREATMENT"] }, orderBy: { createdAt: "desc" }, take: 3, select: { meta: true } });
    check("T431a C 類規則連續 3 次 scan = DEP_FAIL（lastScanResult + audit 留痕）", cRule?.lastScanResult === "DEP_FAIL" && audits.length === 3 && audits.every((a) => (a.meta as any)?.result === "DEP_FAIL"), { cRule, audits: audits.map((a) => (a.meta as any)?.result) });
    const { buildFollowupHubSummary } = await import("../src/lib/followup/hub-summary-p4");
    const hub = await buildFollowupHubSummary();
    const dep = (hub.health ?? []).find((h: any) => h.id === "scan_dep_fail");
    check("T431b hub 紅字：scan_dep_fail ok=false（C 類規則名入 reason）", dep?.ok === false && typeof dep?.reason === "string" && dep.reason.includes("術後關懷"), dep);
  }

  // ── T432：retention env 唔一致 → 站照開 + purge skipped + Alert HIGH（cwi-final S0-11）────────
  console.log("\n[T432] retention env 一致性（S0-11：唔准停站）");
  {
    const runWorker = (env: NodeJS.ProcessEnv, waitMs: number): Promise<{ code: number | null; out: string; okString: boolean }> =>
      new Promise((resolve) => {
        // ★ cwi-final S2-1（T430d 假紅修復）：detached 開新 process group — 舊版 kill SIGTERM 只殺 npx wrapper，
        //   tsx→node worker 留做孤兒（吊住 Redis cron queue 會搶後続 e2e 嘅 job，log 入死 pipe）。
        const child = spawn("npx", ["tsx", "src/workers/index.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
        const killGroup = () => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL"); // 整組（npx→tsx→node）
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              /* 已退 */
            }
          }
        };
        let out = "";
        const t = setTimeout(() => killGroup(), waitMs);
        const watch = (b: Buffer) => {
          out += b.toString();
          if (out.includes("all workers running")) {
            clearTimeout(t);
            killGroup();
          }
        };
        child.stdout.on("data", watch);
        child.stderr.on("data", watch);
        child.on("exit", (code) => {
          clearTimeout(t);
          resolve({ code, out, okString: out.includes("all workers running") });
        });
      });
    const { runRetentionPurge } = await import("../src/lib/ops/retention-purge");
    const { runHealthCheck } = await import("../src/lib/health/check");
    const origMedia = process.env.RETENTION_MEDIA_MONTHS;
    // a) env 唔一致 → worker 照起（唔再 exit）+ log 標記跳過
    const bad = await runWorker({ ...process.env, RETENTION_MEDIA_MONTHS: "11" }, 60_000);
    check("T432a env 唔一致（MEDIA 11≠12）→ worker 照起（S0-11 唔停站）+ 跳過標記", bad.okString && bad.out.includes("跳過直至修正"), { code: bad.code, tail: bad.out.slice(-200) });
    // b) 對照：env 一致 → 照起
    const good = await runWorker({ ...process.env }, 60_000);
    check("T432b 對照：env 一致 → worker 照起（all workers running）", good.okString, { code: good.code, tail: good.out.slice(-200) });
    // c) purge 守門：唔一致 → skipped + Message 行數不變
    process.env.RETENTION_MEDIA_MONTHS = "11";
    const msgBefore = await prisma.message.count();
    const skipped = await runRetentionPurge();
    const msgAfter = await prisma.message.count();
    check("T432c purge skipped=RETENTION_ENV_MISMATCH + Message 行數不變", skipped.skipped === "RETENTION_ENV_MISMATCH" && (skipped.mismatches?.length ?? 0) > 0 && msgBefore === msgAfter, { skipped: skipped.skipped, mismatches: skipped.mismatches, msgBefore, msgAfter });
    // d) health-check → Alert(type=retention_env_mismatch, severity=HIGH, resolvedAt=null)
    await prisma.alert.deleteMany({ where: { type: "retention_env_mismatch" } }); // 清舊 residue 防 dedup 誤判
    const alertIdsBefore = (await prisma.alert.findMany({ select: { id: true } })).map((a) => a.id);
    const hc1 = await runHealthCheck();
    const openM = await prisma.alert.findFirst({ where: { type: "retention_env_mismatch", resolvedAt: null }, orderBy: { createdAt: "desc" } });
    check("T432d health-check → Alert retention_env_mismatch HIGH 未解決", hc1.created.some((c) => c.type === "retention_env_mismatch" && c.severity === "HIGH") && openM?.severity === "HIGH" && openM.resolvedAt === null, { created: hc1.created.map((c) => c.type), alert: openM?.id });
    // e) 補返 env → 下一次 health-check 自動 resolve
    process.env.RETENTION_MEDIA_MONTHS = origMedia;
    await runHealthCheck();
    const openM2 = await prisma.alert.findMany({ where: { type: "retention_env_mismatch", resolvedAt: null } });
    check("T432e env 補返 → 下次 health-check 自動 resolve", openM2.length === 0, { stillOpen: openM2.length });
    // cleanup：刪本段新建嘅 alert（防 dev DB 噪音 — 包括其他 type 嘅 live breach）
    const newAlerts = (await prisma.alert.findMany({ select: { id: true } })).filter((a) => !alertIdsBefore.includes(a.id));
    if (newAlerts.length) await prisma.alert.deleteMany({ where: { id: { in: newAlerts.map((a) => a.id) } } });
  }

  // ── T433：privacy 頁改字 ──────────────────────────────────────────────────
  console.log("\n[T433] privacy 頁改字（零第三方品牌 + 伺服器句式）");
  {
    const p = path.resolve(process.cwd(), "src/app/(public)/privacy/page.tsx");
    const src = fs.readFileSync(p, "utf8");
    const srcNorm = src.replace(/\s+/g, " "); // 行斷開嘅句式 — normalize 白字元先 match
    check("T433a 零「Apricot Vita」（大小寫不敏感）", !/apricot vita/i.test(srcNorm));
    check("T433b 新句式（中）：診所管理系統服務供應商（受保密協議約束）", src.includes("診所管理系統服務供應商（受保密協議約束）"));
    check("T433c 新句式（英）：bound by confidentiality obligations", srcNorm.includes("bound by confidentiality obligations"));
    check("T433d 伺服器句式（中）收窄 + 第三方可能境外處理", src.includes("我們自行營運嘅伺服器位於香港") && src.includes("第三方服務供應商可能於香港以外處理資料"));
    check("T433e 伺服器句式（英）third-party ... outside Hong Kong", /third-party service providers may process data outside Hong Kong/i.test(srcNorm));
  }

  // ── 鐵律：零原始電話總掃描 ─────────────────────────────────────────────────
  console.log("\n[PII] 零原始電話總掃描");
  {
    const listRes = await fetch(`${BASE}/api/followups/tasks?limit=200`, { headers: { ...H, Cookie: cookieAll } });
    const listBody = await listRes.json();
    assertNoPii(listBody, "followups/tasks 全列表 API");
    const myTasks = await prisma.followupTask.findMany({ where: { patientApricotId: { startsWith: "cpv3-" } } });
    assertNoPii(myTasks, "followup task rows（contextJson/templateVars/phoneHashes）");
    const msgs = await prisma.message.findMany({ where: { conversationId: { in: convIds } } });
    assertNoPii(msgs.map((m) => m.body), "fixture 對話 Message body");
  }

  // ── cleanup（DB 殘留 + mock 檔）───────────────────────────────────────────
  console.log("\n[CLEANUP] DB 殘留 + mock 檔");
  {
    const taskIds2 = (await prisma.followupTask.findMany({ where: { OR: [{ conversationId: { in: convIds } }, { patientApricotId: { startsWith: "cpv3-" } }, { createdAt: { gte: RUN_START } }] }, select: { id: true } })).map((t) => t.id);
    await prisma.followupTask.deleteMany({ where: { id: { in: taskIds2 } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.aiDraft.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.consultSession.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.painTriageSession.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...convIds, ...taskIds2] } }, { action: { startsWith: "FOLLOWUP_" }, createdAt: { gte: RUN_START } }] } });
    const staffIds = (await prisma.staffUser.findMany({ where: { email: { in: emails } }, select: { id: true } })).map((s) => s.id);
    await prisma.staffClinic.deleteMany({ where: { staffId: { in: staffIds } } });
    await prisma.staffUser.deleteMany({ where: { id: { in: staffIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.staffClinic.deleteMany({ where: { clinicId: CLINIC_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    for (const [real, link] of [
      [MOCK_CLINICAL_REAL, MOCK_CLINICAL],
      [MOCK_FOLLOWUP_REAL, MOCK_FOLLOWUP],
    ] as [string, string][]) {
      try {
        fs.unlinkSync(link);
      } catch {
        /* 冇 */
      }
      try {
        fs.unlinkSync(real);
      } catch {
        /* 冇 */
      }
    }
    try {
      fs.unlinkSync(MOCK_FAIL);
    } catch {
      /* 冇 */
    }
    const residual = await prisma.followupTask.count({ where: { patientApricotId: { startsWith: "cpv3-" } } });
    const residualConv = await prisma.conversation.count({ where: { id: { in: convIds } } });
    check("CLEANUP 零殘留（cpv3-* tasks / fixture convs）", residual === 0 && residualConv === 0, { residual, residualConv });
  }

  console.log(`\n=== e2e-followup-v3 完成：${passCount} 項斷言通過${process.exitCode ? "（有失敗！）" : "（全綠）"} ===`);
}

main()
  .catch((err) => {
    console.error("\n[unhandled]", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // ★ 鐵律收結：import 鏈（prisma/queue）開咗 redis 句柄吊住 event loop — 明確 exit 先走得到
    void prisma
      .$disconnect()
      .catch(() => undefined)
      .finally(() => process.exit(process.exitCode ?? 0));
  });
