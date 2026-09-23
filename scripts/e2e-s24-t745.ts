/**
 * e2e-s24-t745.ts — cwi-final S2-8 其他 v3 小修 驗收（T745）
 *
 *   T745a（scan 健康分類）：非 WorkforceApiError 例外（DB trigger 令 task INSERT 必 fail）
 *                → rule.lastScanResult = **ERROR**（唔係 DEP_FAIL）+ log.error（log 含 kind=ERROR）
 *                + ruleFail 真累加（舊版 0）+ audit FOLLOWUP_SCAN row（result=ERROR — created=0 都寫）。
 *   T745b（audit 量削減）：FOLLOWUP_SCAN AuditLog 只喺 created>0 或 DEP_FAIL/ERROR 先寫：
 *                1. 空 scan（EMPTY）→ 零 row（lastScanAt/lastScanResult 照寫）
 *                2. 有候選（created=1）→ row（result=OK, created=1）
 *                3. workforce 5xx（WORKFORCE_MOCK_FAIL）→ DEP_FAIL row（ruleFail 亦計）
 *   T745c（contacts PATCH SUPERVISOR 擋）：SUPERVISOR PATCH salutation/locale → 403（零改動）；
 *                STAFF 對照 → 200（守門只擋 SUPERVISOR，唔壞正常路徑）。
 *
 * 前置：dev stack live（server 3100 / DB 15432 / redis 6379）。
 * 跑法（repo root）：pnpm -s tsx scripts/e2e-s24-t745.ts
 *
 * 決定性（dev worker cron 每 10 分鐘免疫 — 同 J/L 段慣例）：
 *   - 專屬 clinic E2ES24C-C（零其他 fixture）；規則全部 clinic-scoped。
 *   - T745b-1「空 scan 零 row」收斂：本 clinic 零候選對話 → 無論邊個 process（我/ dev worker）
 *     掃 RULE_A 都 EMPTY → 都唔寫 row → createdAt>t0 斷言零 race。
 *   - T745b-2 dev worker 搶建（同 subject）→ unique partial index 收斂：task 恰 1 行 +
 *     audit row（created=1）由搶到嗰個 process 寫 → 「≥1 row 且 some(created=1)」唔 race。
 *   - T745a trigger 期間 dev worker 其他規則 INSERT 被 block → 佢哋 ERROR — 唔入斷言（scope 自己規則）。
 *   - 段尾 hermetic 清理 + 零殘留 sweep（含 trigger / audit row）。
 *
 * 輸出 markers（mock-e2e.sh M 段 grep）：T745a-OK / T745b-OK / T745c-OK / S24-SWEEP-OK
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.WORKFORCE_MOCK = "1"; // in-process engine 要食 workforce mock
import "./e2e-origin-shim";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";

// ★ fd-level pino capture（必須喺 logger singleton 建立之前）：
//   pino default destination 寫 fd 1（sonic-boom，繞過 process.stdout.write）且喺 pino() 時 bind .write
//   → 喺 import engine（→ @/lib/log createLogger()）之後先 replace 必空（T431 舊慣例嘅 log 捕獲其實一直空 — 佢 soft-assert 兜底）。
//   呢度頂層先裝 wrapper（capture off pass-through）→ withLogCapture 只 toggle 旗。
const _rawStdoutWrite = process.stdout.write.bind(process.stdout);
const _rawStderrWrite = process.stderr.write.bind(process.stderr);
let _captureOn = false;
let _captured = "";
(function installLogCaptureWrapper(): void {
  (process.stdout as any).write = ((chunk: any, ...a: any[]) => {
    if (_captureOn) _captured += String(chunk);
    return _rawStdoutWrite(chunk, ...a);
  }) as never;
  (process.stderr as any).write = ((chunk: any, ...a: any[]) => {
    if (_captureOn) _captured += String(chunk);
    return _rawStderrWrite(chunk, ...a);
  }) as never;
})();

const D = 86_400_000;

// ── 固定 id（cuid 形 — ≥20 lowercase alnum）─────────────────────────────────────────
const COMPANY_CODE = "E2ES24C-CO";
const CLINIC_CODE = "E2ES24C-C";
const STAFF_EMAIL = "e2e-s24@wa-clinic.local";
const SUP_EMAIL = "e2e-s24-sup@wa-clinic.local";
const PASS24 = "e2e-s24-pass-2026";

const CT_A = "s24ctaaaaaaaaaaaaaaaaaaaa01"; // T745b-2 idle 候選（created=1）
const CV_A = "s24cvaaaaaaaaaaaaaaaaaaaa01";
const CT_B = "s24ctbaaaaaaaaaaaaaaaaaaaa02"; // T745a fresh idle 候選（trigger block → ERROR）
const CV_B = "s24cvbaaaaaaaaaaaaaaaaaaaa02";
const CT_P = "s24ctppaaaaaaaaaaaaaaaaaa03"; // T745c PATCH 目標（零 conversation）

const RULE_A = "s24rulea000000000000000a1"; // clinic-scoped CONVERSATION_IDLE（1 日）
const RULE_C = "s24rulec000000000000000c1"; // clinic-scoped AFTER_TREATMENT（DEP_FAIL 用）

const S24_CONVS = [CV_A, CV_B];
const S24_CTS = [CT_A, CT_B, CT_P];
const S24_RULES = [RULE_A, RULE_C];

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passCount++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name}`);
    if (detail !== undefined) console.log(`     detail: ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

const prisma = new PrismaClient();

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS e2e_s24_block ON "FollowupTask"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS e2e_s24_block_task_insert()`);
  await prisma.auditLog.deleteMany({ where: { action: "FOLLOWUP_SCAN", entityId: { in: S24_RULES } } });
  await prisma.followupTask.deleteMany({
    where: { OR: [{ ruleId: { in: S24_RULES } }, { conversationId: { in: S24_CONVS } }] },
  });
  await prisma.message.deleteMany({ where: { conversationId: { in: S24_CONVS } } });
  await prisma.conversation.deleteMany({ where: { id: { in: S24_CONVS } } });
  await prisma.contact.deleteMany({ where: { id: { in: S24_CTS } } });
  await prisma.followupRule.deleteMany({ where: { id: { in: S24_RULES } } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: { in: [STAFF_EMAIL, SUP_EMAIL] } } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: [STAFF_EMAIL, SUP_EMAIL] } } });
  await prisma.clinic.deleteMany({ where: { code: CLINIC_CODE } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function residueCount(): Promise<number> {
  const r = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT (
      (SELECT count(*) FROM "FollowupTask" WHERE "conversationId" IN ('${CV_A}','${CV_B}') OR "ruleId" IN ('${RULE_A}','${RULE_C}'))
      + (SELECT count(*) FROM "Message" WHERE "conversationId" IN ('${CV_A}','${CV_B}'))
      + (SELECT count(*) FROM "Conversation" WHERE id IN ('${CV_A}','${CV_B}'))
      + (SELECT count(*) FROM "Contact" WHERE id IN ('${CT_A}','${CT_B}','${CT_P}'))
      + (SELECT count(*) FROM "FollowupRule" WHERE id IN ('${RULE_A}','${RULE_C}'))
      + (SELECT count(*) FROM "AuditLog" WHERE "action"='FOLLOWUP_SCAN' AND "entityId" IN ('${RULE_A}','${RULE_C}'))
      + (SELECT count(*) FROM "StaffClinic" WHERE "staffId" IN (SELECT id FROM "StaffUser" WHERE email IN ('${STAFF_EMAIL}','${SUP_EMAIL}')))
      + (SELECT count(*) FROM "StaffUser" WHERE email IN ('${STAFF_EMAIL}','${SUP_EMAIL}'))
      + (SELECT count(*) FROM "Clinic" WHERE code='${CLINIC_CODE}')
      + (SELECT count(*) FROM "Company" WHERE code='${COMPANY_CODE}')
    ) AS n`
  );
  return Number(r[0]?.n ?? 0);
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
  const sc = res.headers.getSetCookie?.() ?? [];
  const m = sc.map((c) => c.split(";")[0]).find((c) => c.startsWith("wa_inbox_session="));
  if (!m) throw new Error("login 冇 wa_inbox_session cookie");
  return m;
}

async function api(
  cookie: string,
  method: "GET" | "PATCH" | "POST",
  p: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML error page */
  }
  return { status: res.status, json };
}

async function seedRule(id: string, clinicId: string, trigger: string, delayValue: number, templateName: string): Promise<void> {
  const now0 = new Date();
  await prisma.followupRule.upsert({
    where: { id },
    update: {
      clinicId, name: `S24 E2E ${trigger}`, enabled: true, trigger: trigger as never, delayValue,
      delayUnit: "DAY" as never, reasonCodes: [], templateName, level: "L1" as never, maxSends: 1,
      dedupWindowDays: 0, firstUseConfirmedAt: now0,
    },
    create: {
      id, clinicId, name: `S24 E2E ${trigger}`, enabled: true, trigger: trigger as never, delayValue,
      delayUnit: "DAY" as never, reasonCodes: [], templateName, level: "L1" as never, maxSends: 1,
      dedupWindowDays: 0, firstUseConfirmedAt: now0,
    },
  });
}

/** idle 候選對話（病人 2/3 日冇聲 — RULE_A 1 日 delay 内到期；7 日 global 規則唔命中）。 */
async function mkIdleConv(ct: string, cv: string, waId: string, idleDays: number): Promise<void> {
  const t = new Date(Date.now() - idleDays * D);
  await prisma.contact.create({
    data: { id: ct, clinicId: (await clinicId()), waId, profileName: `S24 P ${waId}`, salutation: null, labels: [], followupOptOut: false },
  });
  await prisma.conversation.create({
    data: { id: cv, clinicId: (await clinicId()), contactId: ct, status: "OPEN", lastInboundAt: t, lastOutboundAt: null, lastMessageAt: t, pinnedPatientApricotId: null, intent: null },
  });
}

let clinicIdCache: string | null = null;
async function clinicId(): Promise<string> {
  if (!clinicIdCache) clinicIdCache = (await prisma.clinic.findUniqueOrThrow({ where: { code: CLINIC_CODE }, select: { id: true } })).id;
  return clinicIdCache;
}

/** T431 慣例（R2 修正）：捕獲 pino JSON line（log 斷言用）— 頂層 wrapper 只 toggle 旗（見檔頭 fd-level 註釋）。 */
async function withLogCapture<T>(fn: () => Promise<T>): Promise<{ ret: T; logs: string }> {
  _captured = "";
  _captureOn = true;
  try {
    const ret = await fn();
    return { ret, logs: _captured };
  } finally {
    _captureOn = false;
  }
}

async function main(): Promise<void> {
  const pg = (await import("node:child_process")).spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "15432", "-q"]);
  if (pg.status !== 0) throw new Error("Postgres 15432 唔喺");

  const probe = await fetch(`${BASE}/`).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`S24-ERR dev server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();

  // ── fixtures：專屬 clinic + STAFF + SUPERVISOR ─────────────────────────────────
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES24C Company" } });
  const clinic = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_CODE, name: "S24 Clinic", waPhoneNumberId: "E2ES24C-C-PH", waDisplayNumber: "+852 0000 7244", waBusinessAccountId: "waba_e2es24" },
  });
  clinicIdCache = clinic.id;
  const argon2 = (await import("argon2")).default;
  const staff = await prisma.staffUser.create({
    data: { email: STAFF_EMAIL, name: "E2E S24 STAFF", role: "STAFF" as never, scopeType: "CLINICS", passwordHash: await argon2.hash(PASS24) },
  });
  await prisma.staffClinic.create({ data: { staffId: staff.id, clinicId: clinic.id, isPrimary: true } });
  await prisma.staffUser.create({
    data: { email: SUP_EMAIL, name: "E2E S24 SUPERVISOR", role: "SUPERVISOR" as never, scopeType: "ALL", passwordHash: await argon2.hash(PASS24) },
  });
  const cookie = await login(STAFF_EMAIL, PASS24);
  const supCookie = await login(SUP_EMAIL, PASS24);

  await seedRule(RULE_A, clinic.id, "CONVERSATION_IDLE", 1, "conversation_followup");
  await seedRule(RULE_C, clinic.id, "AFTER_TREATMENT", 3, "post_op_check");

  const { runFollowupScan } = await import("../src/lib/followup/engine");
  const scanRows = async (ruleId: string, since: Date) =>
    prisma.auditLog.findMany({
      where: { action: "FOLLOWUP_SCAN", entityId: ruleId, createdAt: { gt: since } },
      orderBy: { createdAt: "asc" },
      select: { meta: true, createdAt: true },
    });

  // ══════════════ T745b-1：空 scan（EMPTY）→ audit 零 row（量削減核心斷言）══════════════
  console.log("\n[T745b-1] 空 scan（EMPTY，created=0）→ FOLLOWUP_SCAN 零 row（trace 照寫）");
  {
    const t0 = new Date();
    const r1 = await runFollowupScan();
    const ruleA = await prisma.followupRule.findUnique({ where: { id: RULE_A }, select: { lastScanAt: true, lastScanResult: true } });
    const rows = await scanRows(RULE_A, t0);
    check("T745b-1a EMPTY scan 零 audit row（舊版每輪照寫 → ~864 行/日）", rows.length === 0, { rows: rows.length });
    check("T745b-1b trace 照寫：lastScanAt 刷新 + lastScanResult=EMPTY", !!ruleA?.lastScanAt && ruleA.lastScanResult === "EMPTY", ruleA);
    check("T745b-1c 無例外 → ruleFail=0（真累加基線）", r1.ruleFail === 0, r1);
  }

  // ══════════════ T745b-2：created>0 → audit row（result=OK, created=1）══════════════
  console.log("\n[T745b-2] 有候選（created=1）→ audit row 出現（result=OK）");
  const tCreate = new Date(); // 斷言邊界 = 候選對話創建前（dev worker 搶建時，佢嘅 row 都喺邊界之後）
  await mkIdleConv(CT_A, CV_A, "99082401", 2);
  {
    await runFollowupScan();
    const tasks = await prisma.followupTask.findMany({ where: { conversationId: CV_A, ruleId: RULE_A }, select: { id: true, status: true } });
    const rows = await scanRows(RULE_A, tCreate);
    const createdOnes = rows.filter((r) => (r.meta as any)?.created === 1);
    check("T745b-2a 候選建 SUGGESTED 恰 1 行（subject 收斂 — dev worker 搶建都唯一）", tasks.length === 1 && tasks[0].status === "SUGGESTED", tasks);
    check("T745b-2b created>0 → audit row 出現（some created=1 — 由搶到嘅 process 寫）", rows.length >= 1 && createdOnes.length >= 1, { rows: rows.length, meta: rows.map((r) => (r.meta as any)?.created) });
    check("T745b-2c row.result=OK（唔係 DEP_FAIL/ERROR）", createdOnes.every((r) => (r.meta as any)?.result === "OK"), createdOnes.map((r) => (r.meta as any)?.result));
  }

  // ══════════════ T745a：非 WorkforceApiError 例外 → ERROR（唔係 DEP_FAIL）══════════════
  // 決定性：trigger 先裝（block 全部 FollowupTask INSERT — 無論邊個 process）先建 fresh 候選 CV_B
  //   → CV_B 永無 SUGGESTED 行 → 我 scan 必觸 INSERT → 必 throw（dev worker 唔可能搶建）。
  console.log("\n[T745a] 非 WorkforceApiError 例外（DB trigger block task INSERT）→ ERROR + log.error + ruleFail 累加");
  {
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION e2e_s24_block_task_insert() RETURNS trigger AS $body$ BEGIN RAISE EXCEPTION 'e2e-t745-block'; END; $body$ LANGUAGE plpgsql`
    );
    await prisma.$executeRawUnsafe(`CREATE TRIGGER e2e_s24_block BEFORE INSERT ON "FollowupTask" FOR EACH ROW EXECUTE FUNCTION e2e_s24_block_task_insert()`);
    await mkIdleConv(CT_B, CV_B, "99082402", 3);
    try {
      const t0 = new Date();
      const { ret: rA, logs } = await withLogCapture(() => runFollowupScan());
      const ruleA = await prisma.followupRule.findUnique({ where: { id: RULE_A }, select: { lastScanResult: true } });
      const rows = await scanRows(RULE_A, t0);
      const latest = rows[rows.length - 1];
      const myErrLine = logs.split("\n").find((l) => l.includes("rule scan failed") && l.includes(RULE_A) && l.includes('"kind":"ERROR"'));
      check("T745a1 非 WorkforceApiError 例外 → lastScanResult=ERROR（唔係 DEP_FAIL）", ruleA?.lastScanResult === "ERROR", ruleA);
      check("T745a2 ruleFail 真累加（舊版恒 0）", rA.ruleFail >= 1, rA);
      check("T745a3 ERROR 都寫 audit row（created=0 — spec：created>0 ∨ DEP_FAIL/ERROR）", rows.length >= 1 && (latest?.meta as any)?.result === "ERROR", { rows: rows.length, latest: latest?.meta });
      check("T745a4 log.error 路徑命中（本規則行：rule scan failed + kind=ERROR）", !!myErrLine, myErrLine?.slice(0, 250) ?? logs.slice(-400));
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS e2e_s24_block ON "FollowupTask"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS e2e_s24_block_task_insert()`);
    }
  }

  // ══════════════ T745b-3：workforce 5xx（WorkforceApiError）→ DEP_FAIL + audit row ═════════
  console.log("\n[T745b-3] WorkforceApiError 5xx（MOCK_FAIL）→ DEP_FAIL（分類對照）+ audit row");
  {
    const t0 = new Date();
    process.env.WORKFORCE_MOCK_FAIL = "1";
    let rD: any;
    try {
      rD = await runFollowupScan();
    } finally {
      delete process.env.WORKFORCE_MOCK_FAIL;
    }
    const ruleC = await prisma.followupRule.findUnique({ where: { id: RULE_C }, select: { lastScanResult: true } });
    const rows = await scanRows(RULE_C, t0);
    const latest = rows[rows.length - 1];
    check("T745b-3a 5xx WorkforceApiError → lastScanResult=DEP_FAIL", ruleC?.lastScanResult === "DEP_FAIL", ruleC);
    check("T745b-3b DEP_FAIL 寫 audit row（result=DEP_FAIL）", rows.length >= 1 && (latest?.meta as any)?.result === "DEP_FAIL", { rows: rows.length, latest: latest?.meta });
    check("T745b-3c rule-level 依賴失敗入 ruleFail（5xx 500 唔喺輪內 fail-soft 404/503/0 → 上抛）", rD?.ruleFail >= 1, rD);
  }

  // ══════════════ T745c：SUPERVISOR PATCH contacts → 403（稱呼/語言）══════════════
  console.log("\n[T745c] SUPERVISOR PATCH /api/contacts/:id → 403（零改動）+ STAFF 對照 200");
  await prisma.contact.create({
    data: { id: CT_P, clinicId: clinic.id, waId: "99082403", profileName: "S24 P 99082403", salutation: "林先生", labels: [], followupOptOut: false },
  });
  {
    const p1 = await api(supCookie, "PATCH", `/api/contacts/${CT_P}`, { salutation: "林太" });
    const after1 = await prisma.contact.findUnique({ where: { id: CT_P }, select: { salutation: true, locale: true } });
    check("T745c1 SUPERVISOR PATCH salutation → 403", p1.status === 403, { status: p1.status, body: p1.json });
    check("T745c2 零改動（salutation 仍 林先生）", after1?.salutation === "林先生" && after1?.locale === null, after1);
    const p2 = await api(supCookie, "PATCH", `/api/contacts/${CT_P}`, { locale: "en" });
    const after2 = await prisma.contact.findUnique({ where: { id: CT_P }, select: { salutation: true, locale: true } });
    check("T745c3 SUPERVISOR PATCH locale → 403（零改動）", p2.status === 403 && after2?.locale === null, { status: p2.status, after2 });
    const p3 = await api(cookie, "PATCH", `/api/contacts/${CT_P}`, { salutation: "林太" });
    const after3 = await prisma.contact.findUnique({ where: { id: CT_P }, select: { salutation: true } });
    check("T745c4 對照：STAFF PATCH salutation → 200（守門只擋 SUPERVISOR）", p3.status === 200 && after3?.salutation === "林太", { status: p3.status, after3 });
  }

  // ── hermetic sweep（零殘留）────────────────────────────────────────────────────
  await cleanup();
  const n = await residueCount();
  check("S24-SWEEP 零殘留", n === 0, { n });
  if (n === 0) console.log("S24-SWEEP-OK");
  console.log("T745c-OK");
  console.log("T745b-OK");
  console.log("T745a-OK");

  console.log(`\nS24 total: ${passCount} pass / ${failCount} fail`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(failCount === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("S24-ERR", e);
    try {
      await prisma.$disconnect();
    } catch {
      /* noop */
    }
    process.exit(1);
  });
