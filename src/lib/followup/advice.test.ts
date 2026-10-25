/**
 * ★ cwi-advice-20261024：醫生建議跟進（DOCTOR_ADVICE）— 引擎 + 定向通知 + 報價併卡。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/followup/advice.test.ts
 *   （要 DB：migrate:deploy + db:seed + seed-followup-p4；WORKFORCE_MOCK=1 — ci-src-tests.sh 已設）
 *
 * mock：.dev/workforce-mock-clinical.json（advice + quotes）/ .dev/workforce-mock-followup.json（預約）—
 *   跑前備份、跑完還原（唔污染其他測試／dev 環境）。
 *
 * 覆蓋：
 *   A1 命中 → SUGGESTED（subjectKey advice:<病人>:<日>；dueAt = 診症日 + 0）；contextJson 零原文（冇 snippet）
 *   A2 通知 FOLLOWUP_ADVICE：冇負責人 → 顧問組成員（targetStaffIds）；組外 staff 嘅 bell 見唔到、組員見到
 *   A3 有負責人 → 只通知負責人
 *   A4 排除字成段唔計 → 唔建
 *   A5 診症日之後已約 → 唔建（booked）
 *   A6 同日報價併卡：E 規則唔再出 quote 卡
 *   A7 冪等：再 scan 零新卡、零新通知
 *   A8 立即更新路徑（runDoctorAdviceForPatient）同樣建卡
 *   A9 normalizeAdviceTerms / suggestionExpiryAt（+30 日）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac";
import { closeRedis } from "@/lib/queue";
import { FOLLOWUP_ADVICE_TEMPLATES } from "./factory-defaults";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureEnv(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const env = readFileSync(path.resolve(__dirname, "../../../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    /* fail loud via Prisma */
  }
}
ensureEnv();
process.env.WORKFORCE_MOCK = "1";

const prisma = new PrismaClient();

const PFX = "advt";
const CLINICAL = path.resolve(process.cwd(), ".dev/workforce-mock-clinical.json");
const FOLLOWUP = path.resolve(process.cwd(), ".dev/workforce-mock-followup.json");
const BAK = path.resolve(process.cwd(), ".dev/.advice-test-bak");

const P = {
  hit: { cp: "cpadv-hit", waId: "85290001001", contact: `${PFX}c-hit`, conv: `${PFX}v-hit` },
  mine: { cp: "cpadv-mine", waId: "85290001002", contact: `${PFX}c-mine`, conv: `${PFX}v-mine` },
  excl: { cp: "cpadv-excl", waId: "85290001003", contact: `${PFX}c-excl`, conv: `${PFX}v-excl` },
  booked: { cp: "cpadv-booked", waId: "85290001004", contact: `${PFX}c-booked`, conv: `${PFX}v-booked` },
  manual: { cp: "cpadv-manual", waId: "85290001005", contact: `${PFX}c-manual`, conv: `${PFX}v-manual` },
  // 冇釘選、只係「電話認到」（Contact.identifiedPatientApricotId）
  ident: { cp: "cpadv-ident", waId: "85290001006", contact: `${PFX}c-ident`, conv: `${PFX}v-ident` },
};
const GROUP_ID = `${PFX}group0000000000001`;
const RULE_ID = `${PFX}rule00000000000001`;

const hkDay = (off: number) => new Date(Date.now() + 8 * 3600_000 + off * 86400_000).toISOString().slice(0, 10);
const VISIT = hkDay(-8); // ≥ 7 日 → E 報價規則（7 日）都到期 — 驗併卡
const VISIT_MANUAL = hkDay(-1);

let clinicId: string;
let consultantId: string;
let outsiderId: string;
let assigneeId: string;
let ruleIdsBefore: { id: string; enabled: boolean }[] = [];

function ctxFor(id: string, role: "STAFF" | "ADMIN" = "STAFF"): AuthContext {
  return {
    staff: { id, email: "t@advt.local", name: "advt", role },
    clinicId: null,
    clinicIds: [],
    scopeType: "ALL",
    scopedClinicIds: [],
  } as unknown as AuthContext;
}

function backup(f: string, tag: string): void {
  if (existsSync(f)) copyFileSync(f, `${BAK}-${tag}`);
}
function restore(f: string, tag: string): void {
  if (existsSync(`${BAK}-${tag}`)) {
    copyFileSync(`${BAK}-${tag}`, f);
    rmSync(`${BAK}-${tag}`);
  } else if (existsSync(f)) rmSync(f);
}

async function cleanup(): Promise<void> {
  const convIds = Object.values(P).map((x) => x.conv);
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: { in: convIds } }, select: { id: true } });
  await prisma.staffNoticeRead.deleteMany({ where: { noticeId: { in: notices.map((n) => n.id) } } });
  await prisma.staffNotice.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.followupTask.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.contact.deleteMany({ where: { id: { in: Object.values(P).map((x) => x.contact) } } });
  await prisma.skillGroupMember.deleteMany({ where: { groupId: GROUP_ID } });
  await prisma.skillGroupClinic.deleteMany({ where: { groupId: GROUP_ID } });
  await prisma.skillGroup.deleteMany({ where: { id: GROUP_ID } });
  await prisma.followupRule.deleteMany({ where: { id: RULE_ID } });
  await prisma.staffUser.deleteMany({ where: { email: { in: ["advt-consult@advt.local", "advt-outsider@advt.local", "advt-owner@advt.local"] } } });
}

before(async () => {
  mkdirSync(path.dirname(CLINICAL), { recursive: true });
  backup(CLINICAL, "clinical");
  backup(FOLLOWUP, "followup");
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw, "seed 要有 TKW");
  clinicId = tkw.id;
  const mk = (email: string, name: string) =>
    prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId } } } });
  consultantId = (await mk("advt-consult@advt.local", "ADVT 顧問")).id;
  outsiderId = (await mk("advt-outsider@advt.local", "ADVT 前台")).id;
  assigneeId = (await mk("advt-owner@advt.local", "ADVT 負責人")).id;
  // 顧問組（綁 TKW）
  await prisma.skillGroup.create({ data: { id: GROUP_ID, name: "顧問（ADVT 測試）", code: "ADVT_CONSULT" } });
  await prisma.skillGroupClinic.create({ data: { groupId: GROUP_ID, clinicId } });
  await prisma.skillGroupMember.create({ data: { groupId: GROUP_ID, staffId: consultantId } });
  // 病人 + 對話（釘住病人；mine 有負責人）
  for (const [k, x] of Object.entries(P)) {
    await prisma.contact.create({
      data: { id: x.contact, clinicId, waId: x.waId, profileName: `ADVT ${k}`, labels: [], identifiedPatientApricotId: k === "ident" ? x.cp : null },
    });
    await prisma.conversation.create({
      data: {
        id: x.conv,
        clinicId,
        contactId: x.contact,
        status: "OPEN",
        pinnedPatientApricotId: k === "ident" ? null : x.cp,
        assigneeId: k === "mine" ? assigneeId : null,
        lastMessageAt: new Date(),
      },
    });
  }
  // template + 規則（只 TKW；出廠觸發字 + 排除 advised OHI）
  await prisma.followupTemplate.upsert({
    where: { key: "doctor_advice_followup" },
    update: {},
    create: { ...FOLLOWUP_ADVICE_TEMPLATES[0], language: "zh_HK", approved: false },
  });
  // 其他規則暫停（只驗 DOCTOR_ADVICE + E 併卡）— after 還原
  ruleIdsBefore = await prisma.followupRule.findMany({ where: { enabled: true }, select: { id: true, enabled: true } });
  await prisma.followupRule.updateMany({ where: { enabled: true, trigger: { not: "QUOTED_NOT_BOOKED" } }, data: { enabled: false } });
  await prisma.followupRule.create({
    data: {
      id: RULE_ID,
      clinicId,
      name: "醫生建議跟進（ADVT）",
      enabled: true,
      trigger: "DOCTOR_ADVICE",
      delayValue: 0,
      delayUnit: "DAY",
      reasonCodes: [],
      keywords: [],
      excludeKeywords: ["advised OHI"],
      templateName: "doctor_advice_followup",
    },
  });
  const advice = (cp: string, date: string, matches: { field: string; keyword: string; snippet: string }[], quotedItems: unknown = null) => ({
    visitId: `${PFX}-visit-${cp}`,
    patientApricotId: cp,
    patientCode: null,
    visitDate: date,
    clinicCode: "TKW",
    providerCode: null,
    syncedAt: new Date().toISOString(),
    matches,
    quotedItems,
  });
  writeFileSync(
    CLINICAL,
    JSON.stringify({
      advice: [
        advice(P.hit.cp, VISIT, [{ field: "治療處理", keyword: "advise", snippet: "advise RCT 36, consider crown after" }], [{ text: "crown 36", amount: 8000 }]),
        advice(P.mine.cp, VISIT, [{ field: "診斷", keyword: "suggest", snippet: "suggest implant 46" }]),
        advice(P.excl.cp, VISIT, [{ field: "治療處理", keyword: "advised", snippet: "advised OHI" }]),
        advice(P.booked.cp, VISIT, [{ field: "治療處理", keyword: "recommend", snippet: "recommend scaling" }]),
        advice(P.ident.cp, VISIT, [{ field: "主訴", keyword: "recommend", snippet: "recommend testing" }]),
        advice(P.manual.cp, VISIT_MANUAL, [{ field: "治療處理", keyword: "advise", snippet: "advise filling 26" }]),
      ],
      quotes: [
        {
          id: `${PFX}-quote-hit`,
          patientApricotId: P.hit.cp,
          clinicCode: "TKW",
          sourceVisitDate: VISIT,
          text: "crown 36",
          termShorthand: null,
          nameCn: "牙冠",
          amountMin: 8000,
          amountMax: 8000,
          perUnit: false,
          fdiTeeth: ["36"],
          intent: "not_done",
          certainty: "high",
          source: "parser",
          status: "confirmed",
        },
      ],
    }),
  );
  writeFileSync(
    FOLLOWUP,
    JSON.stringify({
      appointments: [
        {
          clinicCode: "TKW",
          date: hkDay(3),
          start: "10:00",
          end: "10:30",
          providerApricotId: "mock-pract-TKW-1",
          providerName: "ADVT 醫生",
          patientApricotId: P.booked.cp,
          bookingStatus: 0,
          apricotApptId: `${PFX}-appt-booked`,
        },
      ],
    }),
  );
});

after(async () => {
  try {
    await cleanup();
    // 還原其他規則嘅啟用狀態
    for (const r of ruleIdsBefore) await prisma.followupRule.updateMany({ where: { id: r.id }, data: { enabled: r.enabled } });
  } finally {
    restore(CLINICAL, "clinical");
    restore(FOLLOWUP, "followup");
    await closeRedis();
    await prisma.$disconnect();
  }
});

test("A1–A6：clinic scan — 命中建卡、零原文、定向通知、排除、已約、報價併卡", async () => {
  const { runFollowupScan } = await import("./engine");
  const { adviceSubjectKey } = await import("./advice");
  await runFollowupScan();

  const tasks = await prisma.followupTask.findMany({ where: { conversationId: { in: Object.values(P).map((x) => x.conv) } } });
  const hit = tasks.find((t) => t.conversationId === P.hit.conv && t.ruleId === RULE_ID);
  assert.ok(hit, "A1 命中病人要有醫生建議卡");
  assert.equal(hit.status, "SUGGESTED");
  assert.equal(hit.subjectKey, adviceSubjectKey(P.hit.cp, VISIT));
  assert.equal(hit.dueAt.toISOString(), new Date(`${VISIT}T00:00:00+08:00`).toISOString(), "A1 0 日 = 診症日");
  const ctx = hit.contextJson as Record<string, unknown>;
  assert.deepEqual(ctx.matches, [{ field: "治療處理", keyword: "advise" }]);
  assert.deepEqual(ctx.quoteItems, ["crown 36"]);
  assert.ok(!JSON.stringify(hit.contextJson).includes("RCT"), "A1 🔴 contextJson 唔准有原文");

  // A2 通知：冇負責人 → 顧問組
  const n = await prisma.staffNotice.findFirst({ where: { conversationId: P.hit.conv, kind: "FOLLOWUP_ADVICE" } });
  assert.ok(n, "A2 要有 FOLLOWUP_ADVICE 通知");
  assert.ok(n.targetStaffIds.includes(consultantId), "A2 顧問組成員喺收件人");
  assert.ok(!n.targetStaffIds.includes(outsiderId), "A2 組外 staff 唔喺收件人");
  assert.ok(!n.title.includes("ADVT"), "A2 title 零病人資料");
  const { noticesGet } = await import("@/app/api/notices/handler-core");
  const seen = async (sid: string) =>
    ((await (await noticesGet(ctxFor(sid), null)).json()) as { notices: { id: string }[] }).notices.some((x) => x.id === n.id);
  assert.equal(await seen(consultantId), true, "A2 顧問 bell 見到");
  assert.equal(await seen(outsiderId), false, "A2 組外 staff bell 見唔到");

  // A3 有負責人 → 只通知負責人
  const nMine = await prisma.staffNotice.findFirst({ where: { conversationId: P.mine.conv, kind: "FOLLOWUP_ADVICE" } });
  assert.ok(nMine, "A3 有負責人都要通知");
  assert.deepEqual(nMine.targetStaffIds, [assigneeId]);

  // A3b 冇釘選、只係電話認到 → 照樣配到對話
  assert.ok(
    tasks.some((t) => t.conversationId === P.ident.conv && t.ruleId === RULE_ID),
    "A3b 電話認到（冇釘選）都要建卡",
  );

  // A4 排除字 / A5 已約 → 唔建
  assert.equal(tasks.filter((t) => t.conversationId === P.excl.conv).length, 0, "A4 排除字唔建");
  assert.equal(tasks.filter((t) => t.conversationId === P.booked.conv).length, 0, "A5 已約唔建");

  // A6 同日報價併卡：冇 E 卡
  const quoteTasks = tasks.filter((t) => t.conversationId === P.hit.conv && t.subjectKey?.startsWith("quote:"));
  assert.equal(quoteTasks.length, 0, "A6 同日報價併入醫生建議卡（唔出 E 卡）");
});

test("A7 冪等：再 scan 零新卡、零新通知", async () => {
  const { runFollowupScan } = await import("./engine");
  const convIds = Object.values(P).map((x) => x.conv);
  const [t0, n0] = await Promise.all([
    prisma.followupTask.count({ where: { conversationId: { in: convIds } } }),
    prisma.staffNotice.count({ where: { conversationId: { in: convIds } } }),
  ]);
  await runFollowupScan();
  const [t1, n1] = await Promise.all([
    prisma.followupTask.count({ where: { conversationId: { in: convIds } } }),
    prisma.staffNotice.count({ where: { conversationId: { in: convIds } } }),
  ]);
  assert.equal(t1, t0);
  assert.equal(n1, n0);
});

test("A8 立即更新路徑：runDoctorAdviceForPatient 即刻建卡", async () => {
  const { runDoctorAdviceForPatient } = await import("./engine");
  // manual 病人嘅診症日喺 10 日窗內 → A1 scan 已建；先刪走再由立即更新重建
  await prisma.staffNotice.deleteMany({ where: { conversationId: P.manual.conv } });
  await prisma.followupTask.deleteMany({ where: { conversationId: P.manual.conv } });
  const created = await runDoctorAdviceForPatient(P.manual.cp, consultantId);
  assert.equal(created, 1);
  const t = await prisma.followupTask.findFirst({ where: { conversationId: P.manual.conv, ruleId: RULE_ID } });
  assert.ok(t);
  assert.equal(t.subjectKey, `advice:${P.manual.cp}:${VISIT_MANUAL}`);
});

test("A9 純函數：觸發字正規化 + 30 日時效", async () => {
  const { normalizeAdviceTerms, DEFAULT_ADVICE_KEYWORDS } = await import("./advice");
  const { suggestionExpiryAt } = await import("./engine");
  assert.deepEqual(normalizeAdviceTerms(["  advise ", "ADVISE", "", "rec.", "a,b"]), ["advise", "rec.", "a b"]);
  assert.deepEqual(normalizeAdviceTerms("advise, suggest\nTCA"), ["advise", "suggest", "TCA"]);
  assert.ok(DEFAULT_ADVICE_KEYWORDS.includes("adv") && DEFAULT_ADVICE_KEYWORDS.includes("sugg"));
  const due = new Date("2026-10-01T00:00:00Z");
  assert.equal(
    suggestionExpiryAt({ dueAt: due, contextJson: null, rule: { trigger: "DOCTOR_ADVICE" } }).toISOString(),
    new Date(due.getTime() + 30 * 86400_000).toISOString(),
  );
});
