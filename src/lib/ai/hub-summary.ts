/**
 * ★ cwi-hub-b-20260914（Part B B.2）：AI 流程 hub — 七步狀態列 + 系統健康列計算。
 *
 * 鐵律（MD B.2）：摘要**每次載入即時算**（唔入 cache — 數要同 DB 一致，T360 斷言口徑）。
 * scope 跟 Part A 單一來源：`scopedClinicSet(ctx)`（null = 全店無限制：ALL scope / SUPERVISOR）。
 *
 * 七步名（老細已批）：① 安全閘 ② 理解 ③ 對話模式 ④ 搵資料 ⑤ 派俾邊個 ⑥ 出文 ⑦ 發唔發
 * 警示條件 = MD B.4 表逐條（B-4）；anchor = 每行 [調較] 跳轉（B.2 撳行跳設定頁）。
 *
 * 零寫入：本檔純讀（DB / fs / health probe）— hub 頁唔會郁任何業務數據。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { scopedClinicSet, type AuthContext } from "@/lib/rbac";
import { getRedis } from "@/lib/queue";
import { checkAiHealth } from "@/lib/ai/health";
import { resolveLevel, minLevel, globalCap, type AutomationLevel } from "@/lib/ai/automation";
import { CONSULT_TRIGGER_FLOOR } from "@/lib/sessions/consult-trigger";
import { floorTermSet } from "@/lib/sessions/red-flags";
import { LEXICON_DEFAULTS, LexiconParams } from "@/lib/workflow/definitions";
import { fetchDutyRoster as wfDutyRoster, WorkforceApiError } from "@/lib/workforce/client";
import { hkToday } from "@/lib/duty/client";

// ── 型別 ──────────────────────────────────────────────────────────────

export interface HubStep {
  n: number;
  name: string;
  /** 現況摘要（人讀一句 — B.2 表格式） */
  summary: string;
  /** 警示（B-4 條件；空 = 無） */
  warnings: string[];
  /** [調較] / 撳行跳轉 anchor（B.1 對應現有頁） */
  anchor: string;
  /** 機器讀（e2e T360 對 DB 斷言口徑） */
  detail: Record<string, unknown>;
}

export interface HubHealthItem {
  id: "sglang" | "redis" | "workforce" | "meta" | "vapid" | "sw" | "followup";
  ok: boolean;
  /** 紅底時顯示嘅原因（ok=true 時 UI 唔顯示） */
  reason: string;
}

export interface HubSummary {
  steps: HubStep[];
  health: HubHealthItem[];
  /** public/sw.js 嘅 SW_VERSION（client 端比對自己 controller — 過舊 → 紅底） */
  swVersion: string;
  /** 沙盤空狀態示範問題（B.9 — 每療程一條；常量待老細核，見 progress file） */
  demoQuestions: string[];
  /** scope 內 clinic（selector 用） */
  clinics: { id: string; code: string; name: string }[];
}

/** 同 worker 同一口徑：resolveLevel + globalCap（AI_GLOBAL_MAX_LEVEL env kill 全覆蓋）。 */
function levelFor(rows: { category: string; level: string }[], category: string, aiMode: string | null): AutomationLevel {
  return minLevel(resolveLevel(rows, category, aiMode), globalCap());
}

/** 沙盤示範問題（B.9 綠燈 — 跟 dev DB 現有療程/方案；老細核完改字）。 */
export const SANDBOX_DEMO_QUESTIONS: string[] = [
  "我想cool牙，幾錢？", // 矯齒
  "我啲牙好醜，想箍牙改善啲樣", // 矯齒（多輪 CONSULT 入口）
  "我冇咗一颗牙，想問下植牙幾錢", // 植牙
  "我智慧齒经常發炎，想拔掉，幾錢？", // 智慧齒
  "想約個洗牙，几時有空位？", // 洗牙
  "牙有个洞，补牙大概几钱？", // 補牙
];

const STEP_NAMES = ["安全閘", "理解", "對話模式", "搵資料", "派俾邊個", "出文", "發唔發"] as const;
const STEP_ANCHORS = [
  "/admin/workflows#wf-pain-triage", // ① 紅旗區（pain-triage 卡）
  "/admin/ai/keywords", // ② 關鍵詞中心（新）
  "/admin/consult", // ③ AI 傾偈設定
  "/admin/knowledge", // ④ 知識庫
  "/admin/routing-rules", // ⑤ 路由規則（技能組併入此步 — B.5）
  "/admin/workflows#wf-tone", // ⑥ tone 新區（唯讀 guard 清單）
  "/admin/automation", // ⑦ AI 自動化
] as const;

/** 七步契約（name + anchor）— unit/e2e 斷言用單一來源（T360/T368）。 */
export const HUB_STEP_CONTRACT: ReadonlyArray<readonly [string, string]> = [
  [STEP_NAMES[0], STEP_ANCHORS[0]],
  [STEP_NAMES[1], STEP_ANCHORS[1]],
  [STEP_NAMES[2], STEP_ANCHORS[2]],
  [STEP_NAMES[3], STEP_ANCHORS[3]],
  [STEP_NAMES[4], STEP_ANCHORS[4]],
  [STEP_NAMES[5], STEP_ANCHORS[5]],
  [STEP_NAMES[6], STEP_ANCHORS[6]],
];

/** 高價值 PRICE doc 判定（schema 註解口徑）：priceMax/priceMin > 1.5 或 priceMax >= 5000。 */
export function isHighValuePriceDoc(d: { priceMin: number | null; priceMax: number | null }): boolean {
  const { priceMin: lo, priceMax: hi } = d;
  if (hi != null && hi >= 5000) return true;
  if (hi != null && lo != null && lo > 0 && hi / lo > 1.5) return true;
  return false;
}

/** eval 報告：evals/reports/golden-<ts>.json（scripts/eval-golden.ts 產物；per-clinic）。 */
interface EvalReportSummary {
  clinic: string;
  ts: string;
  redFlagRecallRate: number | null;
  redFlagTotal: number;
}
async function loadLatestEvalReports(): Promise<Map<string, EvalReportSummary>> {
  const out = new Map<string, EvalReportSummary>();
  try {
    const dir = path.join(process.cwd(), "evals", "reports");
    const files = (await fs.readdir(dir)).filter((f) => /^golden-\d+\.json$/.test(f));
    // ts 喺文件名 — 由大到細行，同 clinic 首次遇到 = 最新
    const sorted = files.sort((a, b) => b.replace(/\D/g, "").localeCompare(a.replace(/\D/g, "")));
    for (const f of sorted) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as {
          summary?: { clinic?: string; ts?: string; redFlagRecall?: { rate?: number; total?: number } };
        };
        const c = raw.summary?.clinic;
        if (!c || out.has(c)) continue;
        out.set(c, {
          clinic: c,
          ts: raw.summary?.ts ?? "",
          redFlagRecallRate: typeof raw.summary?.redFlagRecall?.rate === "number" ? raw.summary!.redFlagRecall!.rate! : null,
          redFlagTotal: raw.summary?.redFlagRecall?.total ?? 0,
        });
      } catch {
        /* 單檔爛 → 跳（fail-soft） */
      }
    }
  } catch {
    /* 目錄唔存在 = 從未跑過 eval — 正常狀態（警示會出） */
  }
  return out;
}

function parseLexiconEntries(raw: unknown): { term: string; canonical: string }[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const r = LexiconParams.safeParse(raw);
  return r.success ? r.data.entries.map((e) => ({ term: e.term, canonical: e.canonical })) : [];
}

// ── 主入口 ────────────────────────────────────────────────────────────

export async function buildHubSummary(ctx: AuthContext): Promise<HubSummary> {
  const scope = scopedClinicSet(ctx); // null = 全店
  const clinicWhere = scope ? { id: { in: scope } } : {};

  const [clinics, docs, products, groups, groupMembers, groupClinics, rules, wfDefs, policies, consultSettings] =
    await Promise.all([
      prisma.clinic.findMany({
        where: clinicWhere,
        select: { id: true, code: true, name: true, aiMode: true, greetingConfig: true },
        orderBy: { code: "asc" },
      }),
      prisma.knowledgeDoc.findMany({
        // 口徑：scope=null（ALL/SUPERVISOR）= 全店 doc（clinic + global 都算）
        where: { enabled: true, ...(scope ? { OR: [{ clinicId: { in: scope } }, { clinicId: null }] } : {}) },
        select: { id: true, clinicId: true, kind: true, title: true, priceMin: true, priceMax: true, shortDisclaimer: true, keywords: true },
      }),
      prisma.consultProduct.findMany({
        where: scope ? { OR: [{ clinicId: { in: scope } }, { clinicId: null }] } : {},
        select: { id: true, clinicId: true, workflow: true, approvedAt: true, enabled: true },
      }),
      prisma.skillGroup.findMany({ where: { enabled: true }, select: { id: true, name: true, code: true } }),
      prisma.skillGroupMember.findMany({ select: { groupId: true } }),
      prisma.skillGroupClinic.findMany({ select: { groupId: true, clinicId: true } }),
      prisma.routingRule.findMany({
        where: { enabled: true, ...(scope ? { OR: [{ clinicId: { in: scope } }, { clinicId: null }] } : {}) },
        select: { id: true, name: true, keywords: true, intents: true, targetType: true, targetGroupId: true, targetStaffId: true },
      }),
      // workflow params（紅旗附加詞 / 口語表 / triage 參數）— 全局 ∪ scope 內店
      prisma.workflowDefinition.findMany({
        where: {
          status: "ACTIVE",
          key: { in: ["pain-triage", "lexicon", "triage"] },
          ...(scope ? { OR: [{ clinicId: { in: scope } }, { clinicId: null }] } : {}),
        },
        select: { key: true, clinicId: true, params: true },
      }),
      prisma.automationPolicy.findMany({
        where: scope ? { clinicId: { in: scope } } : {},
        select: { clinicId: true, category: true, level: true },
      }),
      // consult 設定（advanced.extraTriggerWords — 附加觸發詞）
      prisma.consultSetting.findMany({
        where: { key: "advanced", ...(scope ? { OR: [{ clinicId: { in: scope } }, { clinicId: null }] } : { clinicId: null }) },
        select: { clinicId: true, value: true },
      }),
    ]);

  const clinicIds = clinics.map((c) => c.id);

  // ── ① 安全閘：紅旗詞 = FLOOR（code 常數，鎖定）∪ pain-triage params 附加詞（全局 ∪ scope 店）──
  const rfFloorCount = floorTermSet().size;
  const painParams = wfDefs
    .filter((w) => w.key === "pain-triage")
    .map((w) => (w.params as { redFlagTerms?: Record<string, string[]> })?.redFlagTerms ?? {});
  const rfExtra = new Set<string>();
  for (const p of painParams)
    for (const terms of Object.values(p)) for (const t of terms) if (t) rfExtra.add(t);
  const redFlagTotal = rfFloorCount + rfExtra.size;
  const step1: HubStep = {
    n: 1,
    name: STEP_NAMES[0],
    summary: `紅旗詞 ${redFlagTotal} 個 · 🔒 ${rfFloorCount} 條鎖定`,
    warnings: [],
    anchor: STEP_ANCHORS[0],
    detail: { redFlagTotal, floorTerms: rfFloorCount, extraTerms: rfExtra.size },
  };

  // ── ② 理解：口語表（lexicon 全局 ∪ scope 店，同 term 店優先，上限 60）+ 觸發詞（FLOOR + 附加）+ 分流詞（RoutingRule.keywords）──
  const lexGlobal = wfDefs.filter((w) => w.key === "lexicon" && w.clinicId === null).flatMap((w) => parseLexiconEntries(w.params));
  const lexClinic = wfDefs.filter((w) => w.key === "lexicon" && w.clinicId !== null).flatMap((w) => parseLexiconEntries(w.params));
  const lexMap = new Map<string, string>();
  for (const e of lexGlobal) lexMap.set(e.term, e.canonical);
  for (const e of lexClinic) lexMap.set(e.term, e.canonical); // 店優先
  // 無任何 row → code defaults（同 getLexicon fail-soft 口徑）
  const lexCount = lexMap.size > 0 ? Math.min(lexMap.size, 60) : LEXICON_DEFAULTS.entries.length;
  const triggerFloorCount = Object.values(CONSULT_TRIGGER_FLOOR).reduce((n, arr) => n + arr.length, 0);
  const triggerExtra = new Set<string>();
  for (const cs of consultSettings) {
    const v = (cs.value as { extraTriggerWords?: string[] } | null)?.extraTriggerWords;
    if (Array.isArray(v)) for (const t of v) if (t) triggerExtra.add(t);
  }
  const routingKeywords = new Set<string>();
  for (const r of rules) for (const k of r.keywords) if (k) routingKeywords.add(k);
  const step2: HubStep = {
    n: 2,
    name: STEP_NAMES[1],
    summary: `口語表 ${lexCount} · 觸發詞 ${triggerFloorCount + triggerExtra.size} · 分流詞 ${routingKeywords.size}`,
    warnings: lexMap.size > 60 ? [`口語表 ${lexMap.size} 條超上限 60 — 運行時會被截斷`] : [],
    anchor: STEP_ANCHORS[1],
    detail: { lexicon: lexCount, lexiconRaw: lexMap.size, triggerFloor: triggerFloorCount, triggerExtra: triggerExtra.size, routingKeywords: routingKeywords.size },
  };

  // ── ③ 對話模式：問診/銷售 = code 恆開（無獨立開關）；預約 = BOOKING_REQUEST L3/L4（真開關）──
  const clinicPolicies = new Map<string, { category: string; level: string }[]>();
  for (const p of policies) {
    if (!clinicPolicies.has(p.clinicId)) clinicPolicies.set(p.clinicId, []);
    clinicPolicies.get(p.clinicId)!.push({ category: p.category, level: p.level });
  }
  const bookingLevels = clinics.map((c) => levelFor(clinicPolicies.get(c.id) ?? [], "BOOKING_REQUEST", c.aiMode));
  const bookingOn = bookingLevels.filter((l) => l === "L3" || l === "L4").length;
  const bookingLabel = bookingOn === 0 ? "關" : bookingOn === clinics.length ? "開" : `部分（${bookingOn}/${clinics.length}）`;
  const allProductsUnsigned = products.length > 0 && products.every((p) => p.approvedAt === null || !p.enabled);
  const step3: HubStep = {
    n: 3,
    name: STEP_NAMES[2],
    summary: `問診 開 · 銷售 開 · 預約 ${bookingLabel}`,
    warnings: allProductsUnsigned ? ["銷售開但方案全部未簽署"] : [],
    anchor: STEP_ANCHORS[2],
    detail: { painTriage: "on", consult: "on", booking: bookingLabel, bookingOnClinics: bookingOn, bookingTotal: clinics.length },
  };

  // ── ④ 搵資料：知識庫 + 方案 + 時段（workforce probe）──
  const productsUnsigned = products.filter((p) => p.approvedAt === null || !p.enabled).length;
  const wfProbe = await probeWorkforce(clinics);
  const step4Warnings: string[] = [];
  if (docs.length === 0) step4Warnings.push("知識庫 = 0");
  if (productsUnsigned > 0) step4Warnings.push(`有 ${productsUnsigned} 個方案未簽署`);
  if (!wfProbe.ok) step4Warnings.push(wfProbe.reason);
  const step4: HubStep = {
    n: 4,
    name: STEP_NAMES[3],
    summary: `知識庫 ${docs.length} 條 · 方案 ${products.length}（${productsUnsigned} 未簽署）· 時段 ${wfProbe.ok ? "接通" : "斷"}`,
    warnings: step4Warnings,
    anchor: STEP_ANCHORS[3],
    detail: { knowledgeDocs: docs.length, products: products.length, productsUnsigned, workforce: wfProbe.ok },
  };

  // ── ⑤ 派俾邊個：技能組 + 路由規則；警示 = 規則指向零成員／零服務店嘅組 ──
  const memberCount = new Map<string, number>();
  for (const m of groupMembers) memberCount.set(m.groupId, (memberCount.get(m.groupId) ?? 0) + 1);
  const groupClinicSet = new Map<string, Set<string>>();
  for (const g of groupClinics) {
    if (!groupClinicSet.has(g.groupId)) groupClinicSet.set(g.groupId, new Set());
    groupClinicSet.get(g.groupId)!.add(g.clinicId);
  }
  let orphanRules = 0;
  const orphanNames: string[] = [];
  for (const r of rules) {
    if (r.targetType !== "GROUP" || !r.targetGroupId) continue;
    const g = groups.find((x) => x.id === r.targetGroupId);
    if (!g) {
      orphanRules++;
      orphanNames.push(r.name);
      continue;
    }
    const members = memberCount.get(g.id) ?? 0;
    const clinicsServed = [...(groupClinicSet.get(g.id) ?? [])].filter((cid) => clinicIds.includes(cid));
    if (members === 0 || clinicsServed.length === 0) {
      orphanRules++;
      orphanNames.push(r.name);
    }
  }
  const step5: HubStep = {
    n: 5,
    name: STEP_NAMES[4],
    summary: `技能組 ${groups.length} · 路由規則 ${rules.length}`,
    warnings: orphanRules > 0 ? [`${orphanRules} 條規則指向零成員／零服務店嘅組（${orphanNames.slice(0, 3).join("、")}${orphanNames.length > 3 ? "…" : ""}）`] : [],
    anchor: STEP_ANCHORS[4],
    detail: { skillGroups: groups.length, routingRules: rules.length, orphanRules },
  };

  // ── ⑥ 出文：文案風格（greetingConfig 店數）+ guard 清單（唯讀鎖死）──
  const toneSet = clinics.filter((c) => c.greetingConfig && Object.keys(c.greetingConfig).length > 0).length;
  const highValueMissing = docs.filter(
    (d) => d.kind === "PRICE" && isHighValuePriceDoc(d) && !(d.shortDisclaimer && d.shortDisclaimer.trim())
  ).length;
  const step6: HubStep = {
    n: 6,
    name: STEP_NAMES[5],
    summary: `文案風格 ${toneSet}/${clinics.length} 店已設 · 9 條把關 🔒`,
    warnings: highValueMissing > 0 ? [`${highValueMissing} 個高價值 PRICE doc 缺 shortDisclaimer`] : [],
    anchor: STEP_ANCHORS[5],
    detail: { toneSetClinics: toneSet, toneTotal: clinics.length, priceGuardRules: 3, claimGuardRules: 9, highValueMissingDisclaimer: highValueMissing },
  };

  // ── ⑦ 發唔發：全部 L1 / 部分 L2 + ★ cwi-final S4-3（A12）痛症問診狀態；警示 = L2 開但 eval 未跑 / recall < 100% ──
  const evals = await loadLatestEvalReports();
  const l2Cells: { clinic: string; category: string }[] = [];
  for (const c of clinics) {
    for (const cat of ["BOOKING_REQUEST", "QUESTION", "OUT_OF_SCOPE", "OTHER"]) {
      const lvl = levelFor(clinicPolicies.get(c.id) ?? [], cat, c.aiMode);
      if (lvl === "L2" || lvl === "L3" || lvl === "L4") l2Cells.push({ clinic: c.code, category: cat });
    }
  }
  const levelLabel = l2Cells.length === 0 ? "全部 L1" : `部分 L2（${l2Cells.length} 格）`;
  // ★ A12：痛症問診狀態（全店預設開 — 只受 global cap L1 / 店 PAIN_TRIAGE row L1 控制）
  const cap = globalCap();
  const painTriageOn = clinics.filter((c) => {
    const row = (clinicPolicies.get(c.id) ?? []).find((r) => r.category === "PAIN_TRIAGE");
    return (row ? row.level !== "L1" : true) && cap !== "L1";
  }).length;
  const painLabel =
    cap === "L1" ? "痛症問診 關（全局 L1 kill）" : painTriageOn === clinics.length ? "痛症問診 開（全店）" : `痛症問診 部分（${painTriageOn}/${clinics.length}）`;
  const step7Warnings: string[] = [];
  if (l2Cells.length > 0) {
    // scope 內有 L2+ 嘅 clinic — 對返該 clinic 最新 eval 報告
    const l2ClinicCodes = [...new Set(l2Cells.map((x) => x.clinic))];
    const notRan = l2ClinicCodes.filter((code) => !evals.has(code));
    const badRecall = l2ClinicCodes
      .map((code) => evals.get(code))
      .filter((e): e is EvalReportSummary => !!e && e.redFlagTotal > 0 && (e.redFlagRecallRate === null || e.redFlagRecallRate < 1));
    if (notRan.length > 0) step7Warnings.push(`L2 已開但 ${notRan.join("、")} 未跑過 eval:golden`);
    if (badRecall.length > 0) step7Warnings.push(`${badRecall.map((e) => e.clinic).join("、")} 紅旗 recall < 100%`);
  }
  const step7: HubStep = {
    n: 7,
    name: STEP_NAMES[6],
    summary: `${levelLabel} · ${painLabel}`,
    warnings: step7Warnings,
    anchor: STEP_ANCHORS[6],
    detail: { level: levelLabel, l2Cells: l2Cells.length, evalClinicsRan: [...evals.keys()].length, painTriageOn: painTriageOn, painTriageTotal: clinics.length, globalCap: cap },
  };

  const { health, swVersion } = await buildHealthRow(clinics);

  return {
    steps: [step1, step2, step3, step4, step5, step6, step7],
    health,
    swVersion,
    demoQuestions: SANDBOX_DEMO_QUESTIONS,
    clinics: clinics.map((c) => ({ id: c.id, code: c.code, name: c.name })),
  };
}

// ── 系統健康列（B-4 頂部；紅底先顯示 — ok=true 嘅項 UI 唔彈出）──────────

async function probeWorkforce(clinics: { id: string; code: string }[]): Promise<{ ok: boolean; reason: string }> {
  if (process.env.WORKFORCE_MOCK === "1") return { ok: true, reason: "mock" };
  if (!process.env.WORKFORCE_API_URL || !process.env.WORKFORCE_API_KEY)
    return { ok: false, reason: "workforce 未設定（env 缺）" };
  const c = clinics[0];
  if (!c) return { ok: true, reason: "no clinic in scope" };
  try {
    await wfDutyRoster(c.code, hkToday());
    return { ok: true, reason: "" };
  } catch (err) {
    if (err instanceof WorkforceApiError) {
      if (err.status === 401 || err.status === 403) return { ok: false, reason: "workforce key 失效" };
      return { ok: false, reason: `workforce ${err.status}` };
    }
    // 3s timeout / DNS / 拒接（WorkforceApiError status=0 已喺上面）/ 壞 shape（zod throw）
    return { ok: false, reason: "workforce 斷線" };
  }
}

async function buildHealthRow(clinics: { id: string; code: string; aiMode: string }[]): Promise<{ health: HubHealthItem[]; swVersion: string }> {
  const items: HubHealthItem[] = [];

  // sglang（AI probe — 3s timeout fail-soft）
  const ai = await checkAiHealth().catch(() => "degraded" as const);
  items.push(ai === "ok" ? { id: "sglang", ok: true, reason: "" } : { id: "sglang", ok: false, reason: `sglang 唔通（${ai}）` });

  // Redis
  try {
    await getRedis().ping();
    items.push({ id: "redis", ok: true, reason: "" });
  } catch {
    items.push({ id: "redis", ok: false, reason: "Redis 斷" });
  }

  // workforce（key 失效 / 斷線）
  const wf = await probeWorkforce(clinics);
  items.push({ id: "workforce", ok: wf.ok, reason: wf.ok ? "" : wf.reason });

  // ★ cwi-followup-p3-20260916（鐵律 3）：follow-up — enabled 規則引用嘅 template 未審批 → 紅底
  //   （窗口過咗嘅發送會 SKIPPED(NO_TEMPLATE)；審批咗先會真發）
  try {
    const [fuRules, fuTemplates, fuSkipped] = await Promise.all([
      prisma.followupRule.findMany({ where: { enabled: true }, select: { templateName: true } }),
      prisma.followupTemplate.findMany({ select: { key: true, approved: true } }),
      prisma.followupTask.count({
        where: { status: "SKIPPED", cancelReason: "NO_TEMPLATE", handledAt: { gte: new Date(Date.now() - 3_600_000) } },
      }),
    ]);
    const approvedKeys = new Set(fuTemplates.filter((t) => t.approved).map((t) => t.key));
    const unapproved = [...new Set(fuRules.map((r) => r.templateName).filter((k) => !approvedKeys.has(k)))];
    if (unapproved.length > 0) {
      const extra = fuSkipped > 0 ? `；近 1 小時 ${fuSkipped} 條 SKIPPED(NO_TEMPLATE)` : "";
      items.push({ id: "followup", ok: false, reason: `${unapproved.length} 個 follow-up template 未審批（${unapproved.join(", ")}）— 過窗發送會 SKIPPED${extra}` });
    } else {
      items.push({ id: "followup", ok: true, reason: "" });
    }
  } catch {
    items.push({ id: "followup", ok: true, reason: "" }); // fail-soft：health 頁唔好因 followup 查詢炸
  }

  // Meta token（WA_MOCK=1 = dev 常綠；real = token 有冇 + phone id）
  if (process.env.WA_MOCK === "1") {
    items.push({ id: "meta", ok: true, reason: "" });
  } else if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
    items.push({ id: "meta", ok: false, reason: "Meta token 未設定" });
  } else {
    items.push({ id: "meta", ok: true, reason: "" });
  }

  // VAPID（三 env 齊先有 Web Push）
  const vapidOk = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
  items.push(vapidOk ? { id: "vapid", ok: true, reason: "" } : { id: "vapid", ok: false, reason: "push VAPID 缺" });

  // SW 版本（server 端讀 public/sw.js 嘅 SW_VERSION 常量；client 端比對自己 controller — 見 ai-hub-client）
  let swExpected = "";
  try {
    const swSrc = await fs.readFile(path.join(process.cwd(), "public", "sw.js"), "utf8");
    const m = swSrc.match(/SW_VERSION\s*=\s*"([^"]+)"/);
    if (m) swExpected = m[1];
  } catch {
    /* fail-soft */
  }
  items.push({ id: "sw", ok: swExpected !== "", reason: swExpected === "" ? "SW 版本讀唔到" : "" });
  return { health: items, swVersion: swExpected };
}
