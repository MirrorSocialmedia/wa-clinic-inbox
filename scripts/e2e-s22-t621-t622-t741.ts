/**
 * e2e-s22-t621-t622-t741.ts — cwi-final S2-2/S2-3/S2-4 驗收
 *
 *   T621（S2-2）：有 SUGGESTED → 病人 opt-out（in-process applyFollowupOptOut source=auto）
 *                → task CANCELLED(OPT_OUT)+handledAt、contact 旗標、膠囊集合（loadFollowupDue）-1、
 *                  recheck 收斂（連跑兩次第二次 0 = 零 flap；第一次容許收 dev 舊 backlog）。
 *   T622（S2-3）：① 守門③接活 — idle 對話 + SUGGESTED → runAutoResolveSweep 後仍 OPEN；
 *                控制組（同 idle、無 SUGGESTED、intent=CLOSING 擋 A 類 scan）→ RESOLVED。
 *                ② RESOLVED 對話 + B 類建議 → loadFollowupDue / loadCounts.followup /
 *                  loadFollowupCapsuleRows 全部包含（膠囊計數同列表都有 — RESOLVED 照喺列）。
 *   T741（S2-4）：專屬 clinic + staff（socket 入 clinic room）+ 2 日 idle 對話 + clinic-scoped
 *                IDLE 規則 → in-process runFollowupScan 建 SUGGESTED → 另一 tab（socket client）
 *                收 followup:changed（事件到達 ≤ 3s，以 task 落庫時刻起計 = 膠囊 +1 口徑）
 *                + GET /api/conversations?ids= row.followupDueAt 非空（client 補行數據源）
 *                + loadFollowupDue 膠囊集合包含。
 *
 * 前置：dev stack live（server 3100 — T741 socket/API 用 / DB 15432 / redis 6379）。
 * 跑法（repo root）：pnpm -s tsx scripts/e2e-s22-t621-t622-t741.ts
 *
 * 決定性（dev worker cron 每 10 分鐘 scan + 而家連 recheck 一齊跑 — 全部考慮入）：
 *   - T621/T622 用 MF clinic + 固定 cuid 形 id 冪等洗；task 全部 raw create（固定 id）。
 *   - T622 控制組 intent=CLOSING → A 類 scan B-5① 永遠 skip（cron 唔會喺控制組建 task 污染守門③斷言）。
 *   - T622A 已有同 subjectKey task → cron 重建撞 unique partial index → in-flight（收斂）。
 *   - T622C（RESOLVED + B1 task）：cron recheck 跑 checkCancellations 回 RESOLVED →
 *     recheck 刻意 skip（S2-3 行為決定 — RESOLVED 對話建議照留）→ 零 flap。
 *   - T741 專屬 clinic（零其他 fixture）；socket 捕捉按 conversationId 過濾（cron 其他店事件無害）。
 *   - 段尾 hermetic 清理 + 零殘留 sweep。
 *
 * 輸出 markers（mock-e2e.sh K 段 grep）：T621-OK / T622-OK / T741-OK / S22-SWEEP-OK
 */
process.env.WORKFORCE_MOCK = "1"; // in-process engine/opt-out 要食 mock（fetchAppointments 等）
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { io, type Socket } from "socket.io-client";
import { phoneHashes } from "../src/lib/phone-hash";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";

const H = 3_600_000;
const D = 86_400_000;

// ── 固定 id（cuid 形 — ≥20 lowercase alnum）─────────────────────────────────────────
const RULE_A621 = "s22ruleidle00000000000a1"; // MF-scoped CONVERSATION_IDLE 1d（T621 task / T622A）
const RULE_B622 = "s22ruleb10000000000000b1"; // MF-scoped BEFORE_APPOINTMENT 14d（T622C）
const RULE_T741 = "s22rulet7410000000000c1"; // clinic-scoped CONVERSATION_IDLE 1d（T741）

const CT621 = "s22ct621aaaaaaaaaaaaaaa01";
const CV621 = "s22cv621aaaaaaaaaaaaaaa01";
const TASK621 = "s22task621aaaaaaaaaaa001";

const CT622A = "s22ct622aaaaaaaaaaaaaaa02";
const CV622A = "s22cv622aaaaaaaaaaaaaaa02";
const TASK622A = "s22task622aaaaaaaaaaa002";
const CT622B = "s22ct622baaaaaaaaaaaaaa03";
const CV622B = "s22cv622baaaaaaaaaaaaaa03";
const CT622C = "s22ct622caaaaaaaaaaaaaa04";
const CV622C = "s22cv622caaaaaaaaaaaaaa04";
const TASK622C = "s22task622caaaaaaaaaa004";

const COMPANY_CODE = "E2ES22C-CO";
const CLINIC741 = "E2ES22C-C";
const STAFF741_EMAIL = "e2e-s22c@wa-clinic.local";
const PASS741 = "e2e-s22c-pass-2026";
const CT741 = "s22ct741aaaaaaaaaaaaaaa41";
const CV741 = "s22cv741aaaaaaaaaaaaaaa41";
const WA741 = "99082211";
const WA621 = "99082201";
const WA622A = "99082202";
const WA622B = "99082203";
const WA622C = "99082204";

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passCount++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
  }
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

const S22_CONVS = [CV621, CV622A, CV622B, CV622C, CV741];
const S22_CTS = [CT621, CT622A, CT622B, CT622C, CT741];
const S22_TASKS = [TASK621, TASK622A, TASK622C];
const S22_RULES = [RULE_A621, RULE_B622, RULE_T741];

async function cleanup(): Promise<void> {
  await prisma.followupTask.deleteMany({ where: { OR: [{ id: { in: S22_TASKS } }, { conversationId: { in: S22_CONVS } }, { ruleId: { in: S22_RULES } }] } });
  await prisma.conversation.deleteMany({ where: { id: { in: S22_CONVS } } });
  await prisma.contact.deleteMany({ where: { id: { in: S22_CTS } } });
  await prisma.followupRule.deleteMany({ where: { id: { in: S22_RULES } } });
  await prisma.staffNotice.deleteMany({ where: { AND: [{ kind: "SYSTEM" }, { title: { contains: "跟進停止" } }, { meta: { path: ["contactId"], equals: CT621 } }] } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: STAFF741_EMAIL } } });
  await prisma.staffUser.deleteMany({ where: { email: STAFF741_EMAIL } });
  await prisma.clinic.deleteMany({ where: { code: CLINIC741 } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function residueCount(): Promise<number> {
  const r = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT (
      (SELECT count(*) FROM "FollowupTask" WHERE "conversationId" IN (${S22_CONVS.map((c) => `'${c}'`).join(",")}) OR "id" IN (${S22_TASKS.map((t) => `'${t}'`).join(",")}) OR "ruleId" IN (${S22_RULES.map((r2) => `'${r2}'`).join(",")}))
      + (SELECT count(*) FROM "Conversation" WHERE id IN (${S22_CONVS.map((c) => `'${c}'`).join(",")}))
      + (SELECT count(*) FROM "Contact" WHERE id IN (${S22_CTS.map((c) => `'${c}'`).join(",")}))
      + (SELECT count(*) FROM "FollowupRule" WHERE id IN (${S22_RULES.map((r2) => `'${r2}'`).join(",")}))
      + (SELECT count(*) FROM "StaffUser" WHERE email = '${STAFF741_EMAIL}')
      + (SELECT count(*) FROM "Clinic" WHERE code = '${CLINIC741}')
      + (SELECT count(*) FROM "Company" WHERE code = '${COMPANY_CODE}')
    )::int AS n`
  );
  return r[0]?.n ?? -1;
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
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

// ── MF-scoped 規則 fixture（dedupWindowDays=0 隔離冷卻窗）──────────────────────────
async function seedMfRule(id: string, trigger: string, delayValue: number, templateName: string, clinicId: string): Promise<void> {
  const now0 = new Date();
  await prisma.followupRule.upsert({
    where: { id },
    update: {
      clinicId, name: `S22 E2E ${trigger}`, enabled: true, trigger: trigger as never, delayValue,
      delayUnit: "DAY" as never, reasonCodes: [], templateName, level: "L1" as never, maxSends: 1,
      dedupWindowDays: 0, firstUseConfirmedAt: now0,
    },
    create: {
      id, clinicId, name: `S22 E2E ${trigger}`, enabled: true, trigger: trigger as never, delayValue,
      delayUnit: "DAY" as never, reasonCodes: [], templateName, level: "L1" as never, maxSends: 1,
      dedupWindowDays: 0, firstUseConfirmedAt: now0,
    },
  });
}

async function main(): Promise<void> {
  const pg = (await import("node:child_process")).spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "15432", "-q"]);
  if (pg.status !== 0) fail("Postgres 15432 唔喺");

  const mf = await prisma.clinic.findFirst({ where: { code: "MF" } });
  if (!mf) fail("MF clinic 搵唔到（seed？）");

  const probe = await fetch(`${BASE}/`).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`S22-ERR dev server 未 live（status=${probe?.status}）— T741 需要 socket/API`);
    process.exit(2);
  }

  await cleanup();
  const now0 = new Date();

  // ══════════════ T621：opt-out → 已有 SUGGESTED 即時 CANCELLED(OPT_OUT) ══════════════
  console.log("\n[T621] opt-out 取消已存在建議（S2-2 / N-8）");
  await seedMfRule(RULE_A621, "CONVERSATION_IDLE", 1, "conversation_followup", mf.id);
  await prisma.contact.upsert({
    where: { id: CT621 },
    update: { clinicId: mf.id, followupOptOut: false, optOutAt: null, optOutSource: null },
    create: { id: CT621, clinicId: mf.id, waId: WA621, profileName: "S22 T621 P", labels: [] },
  });
  const t621Inbound = new Date(now0.getTime() - 1 * H); // 1 小時前 — A 類候選外（<1d）→ cron 唔會重建
  await prisma.conversation.upsert({
    where: { id: CV621 },
    update: { lastInboundAt: t621Inbound, lastOutboundAt: t621Inbound, lastMessageAt: t621Inbound, status: "OPEN", pinnedPatientApricotId: null },
    create: { id: CV621, clinicId: mf.id, contactId: CT621, status: "OPEN", lastInboundAt: t621Inbound, lastOutboundAt: t621Inbound, lastMessageAt: t621Inbound, pinnedPatientApricotId: null },
  });
  await prisma.followupTask.create({
    data: {
      id: TASK621, clinicId: mf.id, conversationId: CV621,
      patientApricotId: null, phoneHashes: phoneHashes(WA621), ruleId: RULE_A621,
      source: "RULE" as never, dueAt: now0, status: "SUGGESTED" as never,
      templateName: "conversation_followup",
      subjectKey: `idle:${CV621}:${t621Inbound.toISOString()}`,
      contextJson: { idleDays: 0 },
    },
  });

  // 前置：膠囊集合有 CV621（基線 +1 存在）
  const scopeMf = { scopedSet: null, myGroupIds: [], meId: "s22me00000000000000000", clinicParam: mf.id };
  const { loadFollowupDue, loadCounts, loadFollowupCapsuleRows } = await import("../src/lib/inbox/conversation-list");
  const dueBefore = await loadFollowupDue(scopeMf);
  check("T621-pre opt-out 前 loadFollowupDue 有 CV621（基線）", dueBefore.has(CV621), [...dueBefore.keys()].slice(0, 5));

  // 病人講「唔好再搵我」→ inbound.worker 調 applyFollowupOptOut（in-process 模擬 source=auto）
  const { applyFollowupOptOut } = await import("../src/lib/followup/opt-out");
  const optOutRes = await applyFollowupOptOut({ contactId: CT621, source: "auto", now: new Date() });
  check("T621a applyFollowupOptOut changed + cancelledSuggestions=1", optOutRes.changed === true && optOutRes.cancelledSuggestions === 1, optOutRes);

  const taskAfter = await prisma.followupTask.findUnique({ where: { id: TASK621 } });
  check(
    "T621b task → CANCELLED(OPT_OUT) + handledAt",
    taskAfter?.status === "CANCELLED" && taskAfter?.cancelReason === "OPT_OUT" && taskAfter?.handledAt != null,
    { status: taskAfter?.status, cancelReason: taskAfter?.cancelReason }
  );
  const contactAfter = await prisma.contact.findUnique({ where: { id: CT621 }, select: { followupOptOut: true } });
  check("T621c contact.followupOptOut = true", contactAfter?.followupOptOut === true);
  const sugCount621 = await prisma.followupTask.count({ where: { conversationId: CV621, status: "SUGGESTED" } });
  check("T621d 該對話 SUGGESTED 計數 = 0（卡消失數據源）", sugCount621 === 0, sugCount621);
  const dueAfter = await loadFollowupDue(scopeMf);
  check("T621e 膠囊集合（loadFollowupDue）-1：CV621 唔喺", !dueAfter.has(CV621));
  const notice = await prisma.staffNotice.findFirst({ where: { AND: [{ kind: "SYSTEM" }, { meta: { path: ["contactId"], equals: CT621 } }] }, select: { title: true } });
  check("T621f auto 通知 StaffNotice 建咗（店員確認用）", notice != null, notice?.title);

  // recheck 收斂：連跑兩次 — 第二次必 0（零 flap）。第一次容許 >0（dev DB 舊 backlog — 舊 worker 無 recheck 積下嚟嘅
  // 可合法取消 SUGGESTED；新 worker 上線後每 10 分鐘 cron 自然收斂到同一狀態）。新建 SUGGESTED 天生 recheck 穩定
  //   （createTask 已查 OPT_OUT；B1 自身 apptId 排除於 BOOKED 檢查外）→ 第二次 0 係確定性斷言。
  const { recheckOpenSuggestions } = await import("../src/lib/followup/engine");
  const re1 = await recheckOpenSuggestions(new Date());
  const re2 = await recheckOpenSuggestions(new Date());
  console.log(`  recheck: first=${re1}（dev backlog 收斂，容許）/ second=${re2}（必須 0）`);
  check("T621g recheck 收斂（第二次 0 新取消 — 零 flap）", re2 === 0, { re1, re2 });
  const taskAfterRecheck = await prisma.followupTask.findUnique({ where: { id: TASK621 }, select: { status: true, cancelReason: true } });
  check("T621h TASK621 經 recheck 後仍 CANCELLED(OPT_OUT)（唔會 flap 返 SUGGESTED）", taskAfterRecheck?.status === "CANCELLED" && taskAfterRecheck?.cancelReason === "OPT_OUT", taskAfterRecheck);
  console.log("T621-OK");

  // ══════════════ T622a：auto-resolve 守門③接活（S2-3）══════════════════
  console.log("\n[T622a] auto-resolve 守門③：有 SUGGESTED → sweep 唔關");
  const idle4d = new Date(now0.getTime() - 4 * D);
  await prisma.contact.upsert({
    where: { id: CT622A },
    update: { clinicId: mf.id },
    create: { id: CT622A, clinicId: mf.id, waId: WA622A, profileName: "S22 T622A P", labels: [] },
  });
  await prisma.conversation.upsert({
    where: { id: CV622A },
    update: { lastInboundAt: idle4d, lastOutboundAt: idle4d, lastMessageAt: idle4d, status: "OPEN", intent: null, pinnedPatientApricotId: null },
    create: { id: CV622A, clinicId: mf.id, contactId: CT622A, status: "OPEN", lastInboundAt: idle4d, lastOutboundAt: idle4d, lastMessageAt: idle4d, pinnedPatientApricotId: null },
  });
  await prisma.followupTask.create({
    data: {
      id: TASK622A, clinicId: mf.id, conversationId: CV622A,
      patientApricotId: null, phoneHashes: phoneHashes(WA622A), ruleId: RULE_A621,
      source: "RULE" as never, dueAt: now0, status: "SUGGESTED" as never,
      templateName: "conversation_followup",
      subjectKey: `idle:${CV622A}:${idle4d.toISOString()}`,
      contextJson: { idleDays: 4 },
    },
  });
  // 控制組：同 idle 同已覆、無 SUGGESTED；intent=CLOSING → A 類 scan B-5① 永遠 skip（cron 零干擾）
  await prisma.contact.upsert({
    where: { id: CT622B },
    update: { clinicId: mf.id },
    create: { id: CT622B, clinicId: mf.id, waId: WA622B, profileName: "S22 T622B P", labels: [] },
  });
  await prisma.conversation.upsert({
    where: { id: CV622B },
    update: { lastInboundAt: idle4d, lastOutboundAt: idle4d, lastMessageAt: idle4d, status: "OPEN", intent: "CLOSING", pinnedPatientApricotId: null },
    create: { id: CV622B, clinicId: mf.id, contactId: CT622B, status: "OPEN", lastInboundAt: idle4d, lastOutboundAt: idle4d, lastMessageAt: idle4d, intent: "CLOSING", pinnedPatientApricotId: null },
  });

  const { runAutoResolveSweep } = await import("../src/lib/auto-resolve");
  const sweep = await runAutoResolveSweep(new Date(), 3); // daysOverride=3 — 控制組確定性（seed params 無關）
  const cvA = await prisma.conversation.findUnique({ where: { id: CV622A }, select: { status: true } });
  check("T622a1 idle + SUGGESTED → sweep 後仍 OPEN（守門③）", cvA?.status === "OPEN", cvA);
  const cvB = await prisma.conversation.findUnique({ where: { id: CV622B }, select: { status: true } });
  check("T622a2 控制組（同 idle、無 SUGGESTED）→ RESOLVED（sweep 真跑 + 守門①②口徑）", cvB?.status === "RESOLVED", cvB);
  check("T622a3 sweep.resolved ≥ 1", sweep.resolved >= 1, sweep);

  // ══════════════ T622b：RESOLVED 對話 + B 類建議 → 膠囊計數同列表都有 ══════════════
  console.log("\n[T622b] RESOLVED 對話 + B 類建議 → 膠囊（count + 列表）包含");
  await seedMfRule(RULE_B622, "BEFORE_APPOINTMENT", 14, "appt_reminder", mf.id);
  await prisma.contact.upsert({
    where: { id: CT622C },
    update: { clinicId: mf.id },
    create: { id: CT622C, clinicId: mf.id, waId: WA622C, profileName: "S22 T622C P", labels: [] },
  });
  await prisma.conversation.create({
    data: {
      id: CV622C, clinicId: mf.id, contactId: CT622C, status: "RESOLVED",
      lastInboundAt: idle4d, lastOutboundAt: idle4d, lastMessageAt: idle4d,
      resolvedAt: new Date(now0.getTime() - 2 * D),
    },
  });
  await prisma.followupTask.create({
    data: {
      id: TASK622C, clinicId: mf.id, conversationId: CV622C,
      patientApricotId: "cps22c622", phoneHashes: phoneHashes(WA622C), ruleId: RULE_B622,
      source: "RULE" as never, dueAt: now0, status: "SUGGESTED" as never,
      templateName: "appt_reminder",
      subjectKey: "appt:s22apt-t622c-none",
      contextJson: { apptId: "s22apt-t622c-none", idleDays: 0 },
    },
  });
  const dueC = await loadFollowupDue(scopeMf);
  check("T622b1 loadFollowupDue 有 CV622C（RESOLVED 唔排除）", dueC.has(CV622C));
  const counts = await loadCounts(scopeMf, dueC);
  check("T622b2 loadCounts.followup ≥ 1（膠囊計數）", counts.followup >= 1, counts);
  const rows = await loadFollowupCapsuleRows(scopeMf, dueC);
  const rowC = rows.rows.find((r) => r.id === CV622C);
  check("T622b3 膠囊列表 rows 有 CV622C（RESOLVED 對話照喺列 — B6 裁決 3）", rowC != null && rowC.status === "RESOLVED", rowC ? { id: rowC.id, status: rowC.status } : null);
  const taskCAfterSweep = await prisma.followupTask.findUnique({ where: { id: TASK622C }, select: { status: true } });
  check("T622b4 B 類建議行未被 sweep 動（仍 SUGGESTED）", taskCAfterSweep?.status === "SUGGESTED", taskCAfterSweep);
  console.log("T622-OK");

  // ══════════════ T741：followup:changed 實時（S2-4）══════════════════════════
  console.log("\n[T741] scan 建建議 → 另一 tab 收 followup:changed（≤3s）+ 膠囊數據源");
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES22C CO" } });
  const clinic741 = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC741, name: "E2ES22C Clinic", waPhoneNumberId: "E2ES22C-C-PH", waDisplayNumber: "+852 0000 7241" },
  });
  await seedMfRule(RULE_T741, "CONVERSATION_IDLE", 1, "conversation_followup", clinic741.id);
  const argon2 = (await import("argon2")).default;
  const staff741 = await prisma.staffUser.create({
    data: { email: STAFF741_EMAIL, name: "E2E S22C STAFF", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(PASS741) },
  });
  await prisma.staffClinic.create({ data: { staffId: staff741.id, clinicId: clinic741.id, isPrimary: true } });
  const ct741 = await prisma.contact.create({
    data: { id: CT741, clinicId: clinic741.id, waId: WA741, profileName: "S2ES22C P741", labels: [] },
  });
  const t741Inbound = new Date(Date.now() - 2 * D); // 2 日 idle > 1d delay
  await prisma.conversation.create({
    data: { id: CV741, clinicId: clinic741.id, contactId: ct741.id, status: "OPEN", lastInboundAt: t741Inbound, lastOutboundAt: t741Inbound, lastMessageAt: t741Inbound, pinnedPatientApricotId: null },
  });

  const cookie741 = await login(STAFF741_EMAIL, PASS741);
  const s = await connectSocket(cookie741);
  const cap: { got: boolean; at: number; taskId: string; status: string; clinicId: string } = { got: false, at: 0, taskId: "", status: "", clinicId: "" };
  s.onAny((event: string, payload: unknown) => {
    const p = (payload ?? {}) as { conversationId?: string; taskId?: string; status?: string; clinicId?: string };
    if (event !== "followup:changed" || p.conversationId !== CV741) return;
    cap.got = true;
    cap.at = Date.now();
    cap.taskId = p.taskId ?? "";
    cap.status = p.status ?? "";
    cap.clinicId = p.clinicId ?? "";
  });
  await sleep(800); // room join async 窗口（T705 慣例）

  // 冪等：cron 殘留 SUGGESTED 洗走（新 subject — 理論上 0）
  await prisma.followupTask.deleteMany({ where: { conversationId: CV741, status: "SUGGESTED" } });

  const { runFollowupScan } = await import("../src/lib/followup/engine");
  const tScan = Date.now();
  const scanRes = await runFollowupScan(new Date());
  console.log(`  scan: ${JSON.stringify({ rules: scanRes.rules, created: scanRes.created, expired: scanRes.expired, rechecked: scanRes.rechecked, inFlight: scanRes.inFlight })}（${Date.now() - tScan}ms）`);

  // task 落庫時刻（100ms poll — cron/本 scan 邊個建到都計；unique 收斂恰 1 行）
  let tCreated = 0;
  let task741: { id: string; status: string } | null = null;
  for (let i = 0; i < 200; i++) {
    const row = await prisma.followupTask.findFirst({ where: { conversationId: CV741, status: "SUGGESTED" }, select: { id: true, status: true } });
    if (row) {
      task741 = row;
      tCreated = Date.now();
      break;
    }
    await sleep(100);
  }
  check("T741a scan 建咗 CV741 SUGGESTED task", task741 != null);
  if (!task741) {
    console.log("T741-FAIL（scan 未建 task）");
    process.exit(1);
  }
  const sugCount741 = await prisma.followupTask.count({ where: { conversationId: CV741, status: "SUGGESTED" } });
  check("T741b 恰 1 條 SUGGESTED（unique 收斂）", sugCount741 === 1, sugCount741);

  // 事件 ≤ 3s（以 task 落庫時刻起計 = 膠囊 +1 口徑：事件 <1s + client debounce 2s）
  const t0 = tCreated;
  while (!cap.got && Date.now() - t0 < 3000) await sleep(50);
  check("T741c followup:changed 事件 ≤3s 到達另一 tab", cap.got, { ms: cap.got ? cap.at - t0 : "timeout", cap: { taskId: cap.taskId, status: cap.status } });
  if (cap.got) {
    check("T741d 事件 payload 對返（taskId/status SUGGESTED/clinicId）", cap.taskId === task741.id && cap.status === "SUGGESTED" && cap.clinicId === clinic741.id, cap);
  }

  // 數據側：client 補行（GET ?ids=）row.followupDueAt 非空 + 膠囊集合包含
  const httpRes = await fetch(`${BASE}/api/conversations?ids=${CV741}`, { headers: { cookie: `wa_inbox_session=${cookie741}` } });
  const httpBody = (await httpRes.json().catch(() => null)) as { items?: { id: string; followupDueAt: string | null; status: string }[] } | null;
  const row741 = httpBody?.items?.find((r) => r.id === CV741) ?? null;
  check("T741e GET /api/conversations?ids= row.followupDueAt 非空（client 補行數據源）", httpRes.status === 200 && row741?.followupDueAt != null, { status: httpRes.status, row: row741 });
  const due741 = await loadFollowupDue({ scopedSet: null, myGroupIds: [], meId: staff741.id, clinicParam: clinic741.id });
  check("T741f loadFollowupDue 膠囊集合有 CV741（計數 +1 數據源）", due741.has(CV741));

  s.disconnect();
  console.log("T741-OK");

  // ── hermetic 清理 + 零殘留 sweep ─────────────────────────────────────────────
  await cleanup();
  const residue = await residueCount();
  check("S22-SWEEP 零殘留", residue === 0, `residue=${residue}`);
  console.log(residue === 0 ? "S22-SWEEP-OK" : "S22-SWEEP-FAIL");

  console.log(`\nS22 total: ${passCount} pass / ${failCount} fail`);
  process.exit(failCount === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("S22-ERR", e instanceof Error ? e.stack ?? e.message : e);
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
