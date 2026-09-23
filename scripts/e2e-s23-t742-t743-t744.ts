/**
 * e2e-s23-t742-t743-t744.ts — cwi-final S2-5/S2-6/S2-7 驗收
 *
 *   T742（S2-5）：過窗 template 發送 = 本地 approved **且** Meta APPROVED（approvedTemplateList 單一來源）：
 *                a. Meta 未批（PENDING）→ 唔發 + task 留 SUGGESTED（等 template 審批）+
 *                   GET /api/followups/tasks row.templateMetaApproved=false（UI「等 template 審批」數據源）。
 *                b. Meta 已批 MARKETING → 發（type=template）+ billingCategory=MARKETING +
 *                   templateMeta.category=MARKETING（真 category，唔再寫死 UTILITY）+
 *                   components.parameters = paramOrder 次序 {type:"text",text} + row.templateWaCategory=MARKETING
 *                   （UI「行銷類 template（收費較高）」數據源）。
 *                c. 窗口內經 engine 路徑（同一 route）→ type=text + billingCategory=SERVICE。
 *   T743（S2-6）：engine 發送原子化（claim + message.create + sentMessageId 同一 $transaction）：
 *                DB trigger 令 message.create 必 fail → 整個 transaction rollback →
 *                task 仍 SUGGESTED + 零 Message + postOpFollowupAt 唔設；撳掉 trigger 再發 → SENT（可重採）。
 *   T744（S2-7）：B-6 術後 72h 覆蓋**全部**草稿（deterministic 痛症訊號 ∨ LLM PAIN → 壓 consult；
 *                CG-010 全草稿 sweep；窗內唔行報價鏈）：
 *                composer 路徑採用 C 類 → postOpFollowupAt 開窗；
 *                A. spec 原句「仲有啲痛，洗牙幾錢？」→ PAIN + 零金額（draft null）+ 無 CONSULT session；
 *                B. 「E2E-CONSULT-TRIG-NOFLOOR 牙齦腫咗」（LLM=QUESTION、詞表 腫=deterministic 痛症訊號）
 *                   → 窗內 consultTrigger 被壓（零 IMPLANT_CONSULT session）；對照（無窗）= IMPLANT_CONSULT 開 session；
 *                C. 「E2E-PRICE-NODISC」（LLM 草稿含 $600–1200）→ 窗內 CG-010 全草稿 sweep block →
 *                   draft 完全棄（null）+ needsHuman；對照（無窗）= 舊路徑 intact（price-guard ① NO_PRICE_TEXT，
 *                   唔係 CG-010）+ unit 口徑隔離；
 *                D. 「洗牙幾錢？」（priceIntent）→ 窗內報價鏈唔行（priceTrace.triggered=false + 草稿零金額）；
 *                   對照（無窗）= 報價鏈行（triggered=true + PRICE doc 金額入 draft）。
 *
 * 前置：dev stack live（server 3100 / DB 15432 / redis 6379）。
 * 跑法（repo root）：pnpm -s tsx scripts/e2e-s23-t742-t743-t744.ts
 *
 * 決定性（dev worker cron 免疫）：專屬 clinic E2ES23C-C（零其他 fixture）；conv 全部
 *   lastInboundAt 1h/48h（A 類 scan 候選外）；patientApricotId=null（BOOKED/ARRIVED 檢查 skip）；
 *   段尾 hermetic 清理 + 零殘留 sweep（含 ConsultSession / KnowledgeDoc / trigger）。
 *
 * 輸出 markers（mock-e2e.sh L 段 grep）：T742-OK / T743-OK / T744-OK / S23-SWEEP-OK
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.WORKFORCE_MOCK = "1"; // in-process engine/pipeline 要食 workforce mock
import "./e2e-origin-shim";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { phoneHashes } from "../src/lib/phone-hash";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";

const H = 3_600_000;

// ── 固定 id（cuid 形 — ≥20 lowercase alnum）─────────────────────────────────────────
const COMPANY_CODE = "E2ES23C-CO";
const CLINIC_CODE = "E2ES23C-C";
const STAFF_EMAIL = "e2e-s23@wa-clinic.local";
const PASS23 = "e2e-s23-pass-2026";

const CT_A = "s23ctaaaaaaaaaaaaaaaaaaaaa01";
const CV_A = "s23cvaaaaaaaaaaaaaaaaaaaaa01";
const TASK_A = "s23taskaaaaaaaaaaaaaaaaaa001";
const CT_B = "s23ctbaaaaaaaaaaaaaaaaaaaa02";
const CV_B = "s23cvbaaaaaaaaaaaaaaaaaaaa02";
const TASK_B = "s23taskbaaaaaaaaaaaaaaaaa002";
const CT_C = "s23ctcaaaaaaaaaaaaaaaaaaa03";
const CV_C = "s23cvcaaaaaaaaaaaaaaaaaaa03";
const TASK_C = "s23taskcaaaaaaaaaaaaaaaaa003";
const CT_D = "s23ctdaaaaaaaaaaaaaaaaaaaa04";
const CV_D = "s23cvdaaaaaaaaaaaaaaaaaaaa04";
const TASK_D = "s23taskdaaaaaaaaaaaaaaaaa004";
const CT_W = "s23ctwaaaaaaaaaaaaaaaaaaaa05";
const CV_W = "s23cvwaaaaaaaaaaaaaaaaaaaa05";
const TASK_W = "s23taskwaaaaaaaaaaaaaaaaa005";
const CT_X = "s23ctxaaaaaaaaaaaaaaaaaaaa06";
const CV_X = "s23cvxaaaaaaaaaaaaaaaaaaaa06";

const RULE_C23 = "s23rulec000000000000000c1"; // clinic-scoped AFTER_TREATMENT（T742/T743 task）
const RULE_T23 = "s23rulet000000000000000t1"; // clinic-scoped AFTER_TREATMENT（T744 task）

const TPL_PEND = "s23tplpend0000000000001"; // 本地 approved + Meta PENDING（waTemplateName=new_arrival_intro）
const TPL_MKT = "s23tplmkt000000000000002"; // 本地 approved + Meta APPROVED MARKETING（waTemplateName=post_op_promo_zh）
const DOC_PRICE = "s23docprice000000000001"; // PRICE doc（洗牙 600–1200 — T744 報價鏈對照）

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passCount++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 500) : "");
  }
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

const S23_CONVS = [CV_A, CV_B, CV_C, CV_D, CV_W, CV_X];
const S23_CTS = [CT_A, CT_B, CT_C, CT_D, CT_W, CT_X];
const S23_TASKS = [TASK_A, TASK_B, TASK_C, TASK_D, TASK_W];
const S23_RULES = [RULE_C23, RULE_T23];
const S23_TPLS = [TPL_PEND, TPL_MKT];

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS e2e_s23_block ON "Message"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS e2e_s23_block_msg_create()`);
  await prisma.followupTask.deleteMany({ where: { OR: [{ id: { in: S23_TASKS } }, { conversationId: { in: S23_CONVS } }, { ruleId: { in: S23_RULES } }] } });
  await prisma.consultSession.deleteMany({ where: { conversationId: { in: S23_CONVS } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: S23_CONVS } } });
  await prisma.conversation.deleteMany({ where: { id: { in: S23_CONVS } } });
  await prisma.contact.deleteMany({ where: { id: { in: S23_CTS } } });
  await prisma.followupRule.deleteMany({ where: { id: { in: S23_RULES } } });
  await prisma.followupTemplate.deleteMany({ where: { key: { in: S23_TPLS } } });
  await prisma.knowledgeDoc.deleteMany({ where: { id: DOC_PRICE } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: STAFF_EMAIL } } });
  await prisma.staffUser.deleteMany({ where: { email: STAFF_EMAIL } });
  await prisma.clinic.deleteMany({ where: { code: CLINIC_CODE } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function residueCount(): Promise<number> {
  const r = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT (
      (SELECT count(*) FROM "FollowupTask" WHERE "conversationId" IN (${S23_CONVS.map((c) => `'${c}'`).join(",")}) OR "id" IN (${S23_TASKS.map((t) => `'${t}'`).join(",")}) OR "ruleId" IN (${S23_RULES.map((x) => `'${x}'`).join(",")}))
      + (SELECT count(*) FROM "ConsultSession" WHERE "conversationId" IN (${S23_CONVS.map((c) => `'${c}'`).join(",")}))
      + (SELECT count(*) FROM "Message" WHERE "conversationId" IN (${S23_CONVS.map((c) => `'${c}'`).join(",")}))
      + (SELECT count(*) FROM "Conversation" WHERE id IN (${S23_CONVS.map((c) => `'${c}'`).join(",")}))
      + (SELECT count(*) FROM "Contact" WHERE id IN (${S23_CTS.map((c) => `'${c}'`).join(",")}))
      + (SELECT count(*) FROM "FollowupRule" WHERE id IN (${S23_RULES.map((x) => `'${x}'`).join(",")}))
      + (SELECT count(*) FROM "FollowupTemplate" WHERE key IN ('${TPL_PEND}','${TPL_MKT}'))
      + (SELECT count(*) FROM "KnowledgeDoc" WHERE id='${DOC_PRICE}')
      + (SELECT count(*) FROM "StaffClinic" WHERE "staffId" IN (SELECT id FROM "StaffUser" WHERE email='${STAFF_EMAIL}'))
      + (SELECT count(*) FROM "StaffUser" WHERE email='${STAFF_EMAIL}')
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

async function seedRule(id: string, clinicId: string): Promise<void> {
  const now0 = new Date();
  await prisma.followupRule.upsert({
    where: { id },
    update: {
      clinicId, name: "S23 E2E AFTER_TREATMENT", enabled: true, trigger: "AFTER_TREATMENT" as never, delayValue: 3,
      delayUnit: "DAY" as never, reasonCodes: [], templateName: "post_op_check", level: "L1" as never, maxSends: 1,
      dedupWindowDays: 0, firstUseConfirmedAt: now0,
    },
    create: {
      id, clinicId, name: "S23 E2E AFTER_TREATMENT", enabled: true, trigger: "AFTER_TREATMENT" as never, delayValue: 3,
      delayUnit: "DAY" as never, reasonCodes: [], templateName: "post_op_check", level: "L1" as never, maxSends: 1,
      dedupWindowDays: 0, firstUseConfirmedAt: now0,
    },
  });
}

async function api(cookie: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${p}`, {
    method: body ? "POST" : "GET",
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

async function main(): Promise<void> {
  const pg = (await import("node:child_process")).spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "15432", "-q"]);
  if (pg.status !== 0) fail("Postgres 15432 唔喺");

  const probe = await fetch(`${BASE}/`).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`S23-ERR dev server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();
  const now0 = new Date();

  // ── fixtures：專屬 clinic + staff + templates + PRICE doc ─────────────────────
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES23C Company" } });
  const clinic = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_CODE, name: "S23 Clinic", waPhoneNumberId: "E2ES23C-C-PH", waDisplayNumber: "+852 0000 7243", waBusinessAccountId: "waba_e2es23" },
  });
  const argon2 = (await import("argon2")).default;
  const staff = await prisma.staffUser.create({
    data: { email: STAFF_EMAIL, name: "E2E S23 STAFF", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(PASS23) },
  });
  await prisma.staffClinic.create({ data: { staffId: staff.id, clinicId: clinic.id, isPrimary: true } });
  const cookie = await login(STAFF_EMAIL, PASS23);

  // S2-5 fixtures：兩款 registry template（本地 approved=true — Meta 狀態決定一切）
  await prisma.followupTemplate.create({
    data: {
      key: TPL_PEND, name: "S23 Meta PENDING", language: "zh_HK",
      text: "{{salutation}}您好，{{clinicName}}想跟進您之前嘅查詢，方便嘅時候回覆我地就得。",
      waTemplateName: "new_arrival_intro", // MOCK_TEMPLATES 入面 = PENDING
      approved: true, approvedAt: now0, approvedBy: "e2e-s23",
      paramOrder: ["salutation", "clinicName"],
    },
  });
  await prisma.followupTemplate.create({
    data: {
      key: TPL_MKT, name: "S23 Meta MARKETING", language: "zh_HK",
      text: "{{salutation}}您好，{{clinicName}}（{{visitDate}}）想跟進您術後康復情況，順便同您分享咗個洗牙保養計劃。",
      waTemplateName: "post_op_promo_zh", // MOCK_TEMPLATES 入面 = APPROVED + MARKETING
      approved: true, approvedAt: now0, approvedBy: "e2e-s23",
      paramOrder: ["salutation", "clinicName", "visitDate"],
    },
  });
  // T744 報價鏈對照用 PRICE doc（洗牙 600–1200；高價值 → shortDisclaimer 必填口徑照給）
  await prisma.knowledgeDoc.create({
    data: {
      id: DOC_PRICE, clinicId: clinic.id, kind: "PRICE" as never, title: "S23 洗牙收費",
      keywords: ["洗牙", "潔齒", "洗牙幾錢"], body: "影響因素：牙石多寡同牙肉狀況會影響時間同價格。",
      disclaimer: "實際收費以到店評估為準，歡迎致電查詢。", shortDisclaimer: "以到店為準",
      priceMin: 600, priceMax: 1200, enabled: true,
    },
  });
  await seedRule(RULE_C23, clinic.id);
  await seedRule(RULE_T23, clinic.id);

  const mkConv = async (ct: string, cv: string, waId: string, salutation: string, lastInboundAgoMs: number) => {
    const t = new Date(now0.getTime() - lastInboundAgoMs);
    await prisma.contact.upsert({
      where: { id: ct },
      update: { clinicId: clinic.id, salutation, followupOptOut: false },
      create: { id: ct, clinicId: clinic.id, waId, profileName: `S23 P ${waId}`, salutation, labels: [] },
    });
    await prisma.conversation.upsert({
      where: { id: cv },
      update: { lastInboundAt: t, lastOutboundAt: t, lastMessageAt: t, status: "OPEN", pinnedPatientApricotId: null, postOpFollowupAt: null },
      create: { id: cv, clinicId: clinic.id, contactId: ct, status: "OPEN", lastInboundAt: t, lastOutboundAt: t, lastMessageAt: t, pinnedPatientApricotId: null },
    });
  };
  const mkTask = async (id: string, ruleId: string, cv: string, waId: string, templateName: string, templateVars?: Record<string, string | number | null>) => {
    await prisma.followupTask.create({
      data: {
        id, clinicId: clinic.id, conversationId: cv, patientApricotId: null, phoneHashes: phoneHashes(waId),
        ruleId, source: "RULE" as never, dueAt: now0, status: "SUGGESTED" as never, templateName,
        subjectKey: `tx:s23${id}`, contextJson: { visitDate: "2026-09-20" },
        templateVars: templateVars ?? { visitDate: "2026-09-20" },
      },
    });
  };

  // ══════════════ T742a：過窗 + 本地 approved + Meta PENDING → 唔發（等 template 審批）══════════════
  console.log("\n[T742a] 過窗 + Meta 未審批 → 唔發 + task 留 SUGGESTED（等 template 審批）");
  await mkConv(CT_A, CV_A, "99082301", "陳先生", 48 * H);
  await mkTask(TASK_A, RULE_C23, CV_A, "99082301", TPL_PEND);
  {
    const r = await api(cookie, `/api/followups/tasks/${TASK_A}`, { action: "send" });
    const after = await prisma.followupTask.findUnique({ where: { id: TASK_A }, select: { status: true, cancelReason: true } });
    const msgCount = await prisma.message.count({ where: { conversationId: CV_A } });
    check("T742a1 過窗 + Meta PENDING → SKIPPED(NO_TEMPLATE) 唔真發", r.status === 200 && r.json?.result?.status === "SKIPPED" && r.json?.result?.cancelReason === "NO_TEMPLATE", r);
    check("T742a2 task 留 SUGGESTED（審批後可再採用 — 唔 terminal）", after?.status === "SUGGESTED", after);
    check("T742a3 零 Message", msgCount === 0, msgCount);
    const list = await api(cookie, `/api/followups/tasks?status=SUGGESTED&conversationId=${CV_A}`);
    const row = list.json?.tasks?.[0];
    check("T742a4 row.templateMetaApproved=false（UI「等 template 審批」數據源）", row?.templateMetaApproved === false, row && { templateApproved: row.templateApproved, templateMetaApproved: row.templateMetaApproved, templateWaCategory: row.templateWaCategory });
    check("T742a5 row.templateApproved=true（本地已批 — 唔係本地審批問題）", row?.templateApproved === true, row?.templateApproved);
  }

  // ══════════════ T742b：過窗 + Meta APPROVED MARKETING → 發 + 真 category + paramOrder parameters ══
  console.log("\n[T742b] 過窗 + Meta APPROVED MARKETING → 發（MARKETING 計費 + components.parameters 次序）");
  await mkConv(CT_B, CV_B, "99082302", "陳先生", 48 * H);
  await mkTask(TASK_B, RULE_C23, CV_B, "99082302", TPL_MKT);
  {
    const list0 = await api(cookie, `/api/followups/tasks?status=SUGGESTED&conversationId=${CV_B}`);
    const row0 = list0.json?.tasks?.[0];
    check("T742b0 row.templateWaCategory=MARKETING + templateMetaApproved=true（UI「行銷類 template（收費較高）」數據源）", row0?.templateWaCategory === "MARKETING" && row0?.templateMetaApproved === true, row0 && { templateWaCategory: row0.templateWaCategory, templateMetaApproved: row0.templateMetaApproved });

    const r = await api(cookie, `/api/followups/tasks/${TASK_B}`, { action: "send" });
    const after = await prisma.followupTask.findUnique({ where: { id: TASK_B }, select: { status: true, sentMessageId: true } });
    const msg = await prisma.message.findFirst({
      where: { conversationId: CV_B, direction: "OUT" },
      orderBy: { createdAt: "desc" },
      select: { id: true, type: true, body: true, billingCategory: true, sentVia: true, templateMeta: true },
    });
    check("T742b1 SENT（viaTemplate）", r.status === 200 && r.json?.result?.status === "SENT" && after?.status === "SENT" && after?.sentMessageId === msg?.id, { r: r.json, after, msgId: msg?.id });
    check("T742b2 Message.type=template + billingCategory=MARKETING（真 category — 唔再寫死 UTILITY）", msg?.type === "template" && msg?.billingCategory === "MARKETING", { type: msg?.type, billingCategory: msg?.billingCategory });
    const tm = (msg?.templateMeta ?? {}) as { name?: string; category?: string; components?: { type: string; parameters: { type: string; text: string }[] }[] };
    check("T742b3 templateMeta.name=post_op_promo_zh + category=MARKETING（Meta 真值快照）", tm.name === "post_op_promo_zh" && tm.category === "MARKETING", tm);
    check(
      "T742b4 components.parameters = paramOrder 次序（陳先生 / S23 Clinic / 2026-09-20）{type:text}",
      Array.isArray(tm.components?.[0]?.parameters) &&
        tm.components?.[0]?.parameters.length === 3 &&
        JSON.stringify(tm.components?.[0]?.parameters.map((p: { text?: string; type?: string }) => p.text)) ===
          JSON.stringify(["陳先生", "S23 Clinic", "2026-09-20"]) &&
        tm.components?.[0]?.parameters.every((p: { type?: string }) => p.type === "text"),
      tm.components?.[0]?.parameters
    );
    check("T742b5 body = 渲染後文字（變數已填）", typeof msg?.body === "string" && msg.body.startsWith("陳先生您好，S23 Clinic（2026-09-20）"), msg?.body);
    check("T742b6 sentVia=AI_ADOPTED", msg?.sentVia === "AI_ADOPTED", msg?.sentVia);
  }

  // ══════════════ T742c：窗口內經 engine 路徑（同一 route）→ text + SERVICE ══════════════
  console.log("\n[T742c] 窗口內經 engine 路徑 → free-form text + SERVICE 計費");
  await mkConv(CT_C, CV_C, "99082303", "陳先生", 1 * H);
  await mkTask(TASK_C, RULE_C23, CV_C, "99082303", TPL_MKT);
  {
    const r = await api(cookie, `/api/followups/tasks/${TASK_C}`, { action: "send" });
    const after = await prisma.followupTask.findUnique({ where: { id: TASK_C }, select: { status: true, sentMessageId: true } });
    const msg = await prisma.message.findFirst({
      where: { conversationId: CV_C, direction: "OUT" },
      orderBy: { createdAt: "desc" },
      select: { id: true, type: true, billingCategory: true, templateMeta: true },
    });
    check("T742c1 SENT（窗口內 — 審批 gate 唔適用）", r.status === 200 && r.json?.result?.status === "SENT" && after?.status === "SENT", { r: r.json, after });
    check("T742c2 Message.type=text + templateMeta=null（窗口內 = free-form）", msg?.type === "text" && (msg?.templateMeta == null), { type: msg?.type, templateMeta: msg?.templateMeta });
    check("T742c3 billingCategory=SERVICE（窗口內口徑）", msg?.billingCategory === "SERVICE", msg?.billingCategory);
  }

  // ══════════════ T743：engine 發送原子化（claim + create + sentMessageId 同一 $transaction）══════════════
  console.log("\n[T743] message.create 失敗（DB trigger）→ transaction rollback → task 仍 SUGGESTED");
  await mkConv(CT_D, CV_D, "99082304", "陳先生", 1 * H);
  await mkTask(TASK_D, RULE_C23, CV_D, "99082304", TPL_MKT);
  {
    // DB 層 mock：該 conv 嘅 Message INSERT 必 fail（trigger RAISE EXCEPTION）
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION e2e_s23_block_msg_create() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'E2E-S23 block message create'; END; $f$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS e2e_s23_block ON "Message"`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER e2e_s23_block BEFORE INSERT ON "Message" FOR EACH ROW WHEN (NEW."conversationId" = '${CV_D}') EXECUTE FUNCTION e2e_s23_block_msg_create()`);

    const { sendFollowupTask } = await import("../src/lib/followup/engine");
    let threw = false;
    try {
      await sendFollowupTask(TASK_D, { staffId: staff.id });
    } catch {
      threw = true;
    }
    const after = await prisma.followupTask.findUnique({ where: { id: TASK_D }, select: { status: true, cancelReason: true, sentMessageId: true, handledAt: true } });
    const msgCount = await prisma.message.count({ where: { conversationId: CV_D } });
    const conv = await prisma.conversation.findUnique({ where: { id: CV_D }, select: { postOpFollowupAt: true } });
    check("T743a message.create 失敗 → sendFollowupTask throw（API 層 = 500）", threw === true);
    check("T743b task 仍 SUGGESTED（transaction rollback — 唔係 SENT 撕裂）", after?.status === "SUGGESTED" && after?.sentMessageId == null && after?.handledAt == null, after);
    check("T743c 零 Message（claim 同 create 一齊 rollback）", msgCount === 0, msgCount);
    check("T743d postOpFollowupAt 唔設（enqueue 未成功 — S2-6 新口徑）", conv?.postOpFollowupAt == null, conv);

    // 撳掉 trigger → 同一 task 再採 → SENT（「修好可重採」口徑）
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS e2e_s23_block ON "Message"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS e2e_s23_block_msg_create()`);
    const r = await sendFollowupTask(TASK_D, { staffId: staff.id });
    const msg = await prisma.message.findFirst({ where: { conversationId: CV_D, direction: "OUT" }, select: { id: true, type: true, billingCategory: true } });
    const after2 = await prisma.followupTask.findUnique({ where: { id: TASK_D }, select: { status: true, sentMessageId: true } });
    check("T743e 修好（trigger 除）後同一 task 再採 → SENT + Message 存在", r.status === "SENT" && msg != null && after2?.status === "SENT" && after2?.sentMessageId === msg?.id, { r, msg, after2 });
    check("T743f 窗口內重採 = text + SERVICE（口徑一致）", msg?.type === "text" && msg?.billingCategory === "SERVICE", msg);
  }

  // ══════════════ T744：B-6 術後 72h 覆蓋全部草稿（composer 開窗 + 4 組 in-window vs control）══════════════
  console.log("\n[T744] composer 採用 C 類 → 72h 窗開；窗內 4 組（A spec / B deterministic / C CG-010 / D 報價鏈）");
  await mkConv(CT_W, CV_W, "99082305", "黃太", 1 * H);
  await mkConv(CT_X, CV_X, "99082306", "黃太", 1 * H); // control（永無 postOp 窗）
  await mkTask(TASK_W, RULE_T23, CV_W, "99082305", "post_op_check", { visitDate: "2026-09-20" });
  {
    // composer 路徑（建議卡「採用並編輯」— 窗口內 free-form + followupTaskId claim）
    const r = await api(cookie, `/api/messages/send`, {
      conversationId: CV_W, body: "術後多日無聯絡，想跟進您嘅康復情況，有咩唔舒服隨時話我知。", source: "adopted", followupTaskId: TASK_W,
    });
    const after = await prisma.followupTask.findUnique({ where: { id: TASK_W }, select: { status: true, sentMessageId: true } });
    const conv = await prisma.conversation.findUnique({ where: { id: CV_W }, select: { postOpFollowupAt: true, assigneeId: true } });
    const msg = await prisma.message.findFirst({ where: { conversationId: CV_W, direction: "OUT" }, orderBy: { createdAt: "desc" }, select: { id: true, sentVia: true, billingCategory: true } });
    check("T744-pre1 composer 採用 C 類 → SENT + AI_ADOPTED（202 accepted）", (r.status === 200 || r.status === 202) && after?.status === "SENT" && msg?.sentVia === "AI_ADOPTED", { status: r.status, after, msg });
    check("T744-pre2 conv.postOpFollowupAt 已開（72h 窗起點 — 窗口內採用發送口徑）", !!conv?.postOpFollowupAt && Date.now() - conv.postOpFollowupAt.getTime() < 60_000, conv?.postOpFollowupAt);
    check("T744-pre3 發送 auto-claim（assigneeId=發送員工 — Send Lock 生效）", conv?.assigneeId === staff.id, conv?.assigneeId);

    const { runInboundAi, livePersistPort, buildAiContext } = await import("../src/lib/ai/pipeline");
    const clinicRow = await prisma.clinic.findUniqueOrThrow({ where: { id: clinic.id } });
    const runCase = async (cv: string, ct: string, body: string, tag: string) => {
      const trigMsg = await prisma.message.create({
        data: { conversationId: cv, direction: "IN", channel: "API", type: "text", body, status: "SENT", waTimestamp: new Date(), waMessageId: `wamid.e2es23.${tag}` },
      });
      await prisma.conversation.update({ where: { id: cv }, data: { lastInboundAt: trigMsg.waTimestamp, lastMessageAt: trigMsg.waTimestamp } });
      const convRow = await prisma.conversation.findUniqueOrThrow({ where: { id: cv } });
      const ctRow = await prisma.contact.findUniqueOrThrow({ where: { id: ct } });
      const now = Date.now();
      const ctxMessages = buildAiContext([
        { dir: "OUT", body: "術後多日無聯絡，想跟進您嘅康復情況，有咩唔舒服隨時話我知。", ts: new Date(now - 7_200_000), type: "text", channel: "API" },
        { dir: "IN", body: trigMsg.body, ts: trigMsg.waTimestamp as Date, type: "text", channel: "API" },
      ]);
      return runInboundAi({
        clinic: clinicRow,
        msg: { id: trigMsg.id, type: "text", body: trigMsg.body, waMessageId: trigMsg.waMessageId },
        conv: convRow as never,
        contact: { profileName: ctRow.profileName, waId: ctRow.waId },
        ctxMessages,
        isMedia: false,
        persist: livePersistPort({ jobAttemptsMade: 0, jobAttemptsTotal: 3, wamid: trigMsg.waMessageId!, clinicId: clinicRow.id, clinicCode: clinicRow.code }),
      });
    };
    const { extractAmounts } = await import("../src/lib/ai/price-guard");

    // ── Case A（spec 原句）：「仲有啲痛，洗牙幾錢？」→ PAIN + 零金額 + 無 CONSULT ──
    const a = await runCase(CV_W, CT_W, "仲有啲痛，洗牙幾錢？", "casea");
    check("T744a1 spec 原句 → intent=PAIN（PAIN_TRIAGE 入場）+ 唔係急症紅旗", a.result.intent === "PAIN" && a.urgent === false, { intent: a.result.intent, urgent: a.urgent });
    check("T744a2 spec 原句 → 草稿零金額（draft null — 結構性零療程零報價）", (a.result.draft === null || a.result.draft === undefined) && extractAmounts(a.result.draft ?? "").length === 0, { draft: a.result.draft });
    check("T744a3 spec 原句 → consultTrigger=null（痛症讓路 PAIN_TRIAGE）", a.consultTrigger === null, a.consultTrigger);
    const csA = await prisma.consultSession.findMany({ where: { conversationId: CV_W }, select: { workflow: true } });
    check("T744a4 窗內零 CONSULT session（零療程零報價 — 唔開銷售 session）", csA.length === 0, csA);

    // ── Case B：deterministic 痛症訊號（LLM=QUESTION、詞表 腫）→ 窗內壓 consult；對照無窗開 session ──
    const B_BODY = "E2E-CONSULT-TRIG-NOFLOOR 牙齦腫咗";
    const bWin = await runCase(CV_W, CT_W, B_BODY, "caseb-win");
    check("T744b1 窗內 deterministic 痛症訊號（腫）→ LLM 話 QUESTION 都照壓 consultTrigger", bWin.result.intent === "QUESTION" && bWin.consultTrigger === null, { intent: bWin.result.intent, trigger: bWin.consultTrigger });
    const bCtrl = await runCase(CV_X, CT_X, B_BODY, "caseb-ctrl");
    check("T744b2 對照（無 72h 窗）同句 → consultTrigger=IMPLANT_CONSULT（壓制係窗口引起）", bCtrl.result.intent === "QUESTION" && bCtrl.consultTrigger === "IMPLANT_CONSULT", { intent: bCtrl.result.intent, trigger: bCtrl.consultTrigger });
    const csB = await prisma.consultSession.findMany({ where: { conversationId: { in: [CV_W, CV_X] } }, select: { conversationId: true, workflow: true } });
    check("T744b3 窗內零 IMPLANT_CONSULT session；對照有", !csB.some((s) => s.conversationId === CV_W && s.workflow === "IMPLANT_CONSULT") && csB.some((s) => s.conversationId === CV_X && s.workflow === "IMPLANT_CONSULT"), csB);

    // ── Case C：CG-010 全草稿 sweep（LLM 草稿含金額）→ 窗內 block（draft 完全棄 null + needsHuman）；
    //    對照（無窗）= 舊路徑 intact（price-guard ① 無引用金額 → NO_PRICE_TEXT + needsHuman — 舊行為，
    //    唔係 CG-010；證明「窗內草稿死喺 CG-010 sweep」口徑）+ unit 隔離（CG-010 窗外唔啟用）。──
    const { NO_PRICE_TEXT } = await import("../src/lib/ai/price-guard");
    const { runClaimGuard } = await import("../src/lib/ai/claim-guard");
    const cWin = await runCase(CV_W, CT_W, "E2E-PRICE-NODISC", "casec-win");
    check("T744c1 窗內 LLM 草稿含金額（$600–1200）→ CG-010 全草稿 sweep block → draft 完全棄（null）+ needsHuman", cWin.result.draft === null && cWin.result.needsHuman === true, { draft: cWin.result.draft, needsHuman: cWin.result.needsHuman });
    const cCtrl = await runCase(CV_X, CT_X, "E2E-PRICE-NODISC", "casec-ctrl");
    check("T744c2 對照（無窗）同類草稿唔死喺 CG-010 — 舊路徑 intact（price-guard ① → NO_PRICE_TEXT + needsHuman，非 null）", cCtrl.result.draft === NO_PRICE_TEXT && cCtrl.result.needsHuman === true, { draft: cCtrl.result.draft, needsHuman: cCtrl.result.needsHuman });
    const g1 = runClaimGuard({ draft: "建議你做個療程，我哋有優惠方案。", products: [], hasBackendSlot: false, priceDoc: null, postOpCareWindow: true });
    const g2 = runClaimGuard({ draft: "建議你做個療程，我哋有優惠方案。", products: [], hasBackendSlot: false, priceDoc: null, postOpCareWindow: false });
    check("T744c3 CG-010 口徑隔離（unit）：窗內療程/方案詞 block、窗外唔啟用", g1.blocked === true && g1.codes.includes("CG-010") && g2.blocked === false && g2.codes.length === 0, { g1: g1.codes, g2: g2.codes });

    // ── Case D：報價鏈（priceIntent=洗牙幾錢）→ 窗內唔行；對照行 + PRICE doc 金額入 draft ──
    const dWin = await runCase(CV_W, CT_W, "洗牙幾錢？", "cased-win");
    check("T744d1 窗內 priceIntent 報價鏈唔行（triggered=false — 術後問價唔係銷售訊號）", dWin.priceTrace.triggered === false, dWin.priceTrace);
    check("T744d2 窗內草稿零金額（LLM 通用草稿無價 + CG-010 兜底）", (dWin.result.draft === null || extractAmounts(dWin.result.draft).length === 0), { draft: dWin.result.draft });
    const dCtrl = await runCase(CV_X, CT_X, "洗牙幾錢？", "cased-ctrl");
    check("T744d3 對照（無窗）報價鏈行（triggered=true + docId 對住我 PRICE doc）", dCtrl.priceTrace.triggered === true && dCtrl.priceTrace.docId === DOC_PRICE, dCtrl.priceTrace);
    check("T744d4 對照草稿含決定性報價範圍（600–1200 元 — buildPriceDraft 口徑）+ 高價值 shortDisclaimer", typeof dCtrl.result.draft === "string" && dCtrl.result.draft.includes("600") && dCtrl.result.draft.includes("1200") && dCtrl.result.draft.includes("以到店為準"), dCtrl.result.draft);
  }

  console.log("T744-OK");
  console.log("T742-OK");
  console.log("T743-OK");

  // ── hermetic 清理 + 零殘留 sweep ──────────────────────────────────────────────
  await cleanup();
  await sleep(300);
  const residue = await residueCount();
  const trg = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('e2e_s23_block')`);
  check("S23-SWEEP hermetic 清理零殘留（task/conv/contact/rule/tpl/doc/staff/clinic/company + trigger）", residue === 0 && (trg[0]?.n ?? 0) === 0, { residue, trigger: trg[0]?.n });
  if (residue !== 0 || (trg[0]?.n ?? 0) !== 0) fail("S23 殘留 — 見上");
  console.log("S23-SWEEP-OK");

  console.log(`\nS23 total: ${passCount} pass / ${failCount} fail`);
  // ★ 明確 exit（import 鏈 redis handle 吊住 event loop — 唔 exit 會假死；同 s22/e2e-v3 慣例）
  process.exit(failCount === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("S23-FATAL", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
