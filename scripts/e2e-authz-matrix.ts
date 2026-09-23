/**
 * T630 — 全 route 權限矩陣（cwi-final S3-1 + S3-4 — W Stage 3 D1）
 *
 * 設計（spec 行 2486-2509 逐字跟）：
 *   1. 遞迴遍歷 src/app/api 底下全部 route.ts → 解析 export const (GET|POST|PUT|PATCH|DELETE)
 *      + export (async )?function (GET|...)
 *   2. 每個 "METHOD /path" 必須喺 MATRIX 有一行 — 冇 = test fail（新 route 唔登記就紅）
 *   3. 6 個 fixture 身份：STAFF_TY、STAFF_YMT、SUPERVISOR、ADMIN_ALL、
 *      ADMIN_COMPANY_B（公司 B = YMT/TW/MF）、UNAUTH
 *   4. 每格斷言 status；寫入類斷言 DB 冇變（寫 4xx 前後 fingerprint 對照）
 *
 * 口徑：
 *   - S3-1 / S3-4 route = target 行為（呢個 commit 改咗嘅）
 *   - 其餘 route = 現行行為快照（註明邊個 S3-x task 會改 — D2/D3/D4）
 *
 * 執行次序陷阱（設計入）：
 *   - 破壞性 200 格（DELETE / 改 TY companyId）一定排喺同 route 嘅 403 格之後面跑
 *     （Object.entries 保插入序）— 否則 403 格會變 404。
 *   - matrix 跑完即刻還原 TY.companyId（T631 嘅「改唔到 TY 設定」要先行先斷）。
 *
 * 用法：tsx scripts/e2e-authz-matrix.ts --phase=t630|t639
 *   - t630 = MATRIX + T631 + T638（需要 ALLOW_SCOPED_ADMIN=1）
 *   - t639 = flag-off 守衛（需要 ALLOW_SCOPED_ADMIN 未設）
 * fixture 全部 fixed cuid + finally 清理（T750 pattern）。
 */
import fs from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient, Role } from "@prisma/client";
import * as argon2 from "argon2";

// 遞迴搵 route.ts（免外部 glob 依賴 — repo 無 glob/@types/glob；行為 = globSync("src/app/api/**/route.ts")）
function listRouteFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") out.push(p);
    }
  };
  walk(root);
  return out;
}

try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch { /* .env 無就 skip（CI） */ }

const BASE = process.env.T630_BASE ?? "http://127.0.0.1:3100"; // T639：3101 flag-off 實例
const PASS = "d1matrixpass123";
// consult-settings "rules" 有效 value（rulesValueSchema：4 個 boolean 必填）— consult-settings PUT 格 + T631 用
const RULES_VALUE = { ortho_appearance: false, ortho_compare: false, ortho_price: false, ortho_booking: false };
// triage params（TriageParams：3 必填；其餘 default）— workflows PUT 格用（saveDraft 會 PARAMS_SCHEMAS 校驗）
const TRIAGE_PARAMS = { humanCooldownMs: 1800000, confidenceFloor: 0.6, autoThanksReply: "t630 唔緊要，祝你早日康復！" };
const prisma = new PrismaClient();

// ── fixed cuid（24 lowercase alnum — cuid 形）────────────────────────────────
const F = {
  staffTy: "t630stafftya000000000000001",
  staffYmt: "t630staffymt000000000000002",
  supervisor: "t630supvisa000000000000003",
  adminAll: "t630adminalla000000000000004",
  adminCompB: "t630admincompb000000000000005",
  staffDispo: "t630staffdis000000000000006", // DELETE 200 用（一次性）
  staffDispo2: "t630staffdis2000000000000007", // PUT 200 用（一次性 — 避免升 adminCompB 污染後續 CB 格）
  clinicF: "t630clinf0000000000000001", // 主 fixture 診所（公司 B）
  clinicDispo: "t630clindis0000000000000002", // DELETE 200 用（一次性）
  kdocF: "t630kdocf00000000000000001", // knowledge doc（clinicId = TY — 跨公司測試用）
  goldenF: "t630golden0000000000000001",
  goldenTy: "t630goldenty0000000000000001", // TY 店 golden case — DELETE 格（CB 外店 403 / ALL 200 刪）
  contactPre: "t630contactp000000000000001", // prefill fixture：Contact（F 店）
  convPre: "t630convp000000000000000001", // prefill fixture：Conversation（F 店 = STAFF_TY 外店）
  msgPre: "t630msgp000000000000000001", // prefill fixture：IN text Message
  alertF: "t630alertf0000000000000001",
  suggF: "t630sugf00000000000000001",
  followupRule: "t630rule2000000000000001", // 店規則（F 診所）
  ruleTy: "t630rulty0000000000000001", // TY 店規則 — DELETE 403 格用（CB 外店）
  publishDef: "t630pubdef000000000000001", // T631 transient 全局 draft（publish 403 用）
} as const;

const TEST_EMAILS = [
  "t630.staff.ty@wa-clinic.local",
  "t630.staff.ymt@wa-clinic.local",
  "t630.supervisor@wa-clinic.local",
  "t630.admin.all@wa-clinic.local",
  "t630.admin.compB@wa-clinic.local",
  "t630.dispo@wa-clinic.local",
  "t630.dispo2@wa-clinic.local",
  "t630.newall@wa-clinic.local",
  "t630.newcb@wa-clinic.local",
  "t639.caller@wa-clinic.local",
  "t639.compadmin@wa-clinic.local",
  "t639.compstaff@wa-clinic.local",
];

type Id = "STAFF_TY" | "STAFF_YMT" | "SUPERVISOR" | "ADMIN_ALL" | "ADMIN_COMPANY_B" | "UNAUTH";

interface Fixtures {
  clinicTY: { id: string };
  clinicYMT: { id: string };
  clinicTW: { id: string };
  clinicMF: { id: string };
  clinicF: { id: string };
  companyB: { id: string };
  adminCompanyB: { id: string };
  staffTy: { id: string };
  staffYmt: { id: string };
  followupTemplate: { key: string };
  prefillMsg: { id: string };
}

// ── 狀態 ────────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];
const cookie: Record<string, string> = {}; // fixture id → wa_inbox_session=<v>

// 201/200 寫入產物（cleanup 用）
const created: { staff: string[]; clinic: string[]; kdoc: string[]; routing: string[]; skill: string[]; product: string[]; wfDef: string[]; consultSetting: string[] } = {
  staff: [], clinic: [], kdoc: [], routing: [], skill: [], product: [], wfDef: [], consultSetting: [],
};

let clinicTyOriginal: { companyId: string | null } = { companyId: null };
let adminCompBOriginal: { role: Role; scopeType: string; scopeCompanyId: string | null; clinicId: string | null } | null = null;
let templateOriginal: { key: string; approved: boolean; approvedAt: Date | null; approvedBy: string | null; updatedAt: Date; text: string } | null = null;
let tyPolicyOriginal: { level: string } | null = null;
let mockSymlinkCreated = false;

const MOCK_CLINICAL = ".dev/workforce-mock-clinical.json";
const MOCK_CLINICAL_SRC = "/tmp/e2et630-clinical.json";

async function api(
  id: Id,
  method: string,
  urlPath: string,
  body?: unknown
): Promise<{ status: number; json?: any; text?: string }> {
  const headers: Record<string, string> = {};
  if (id !== "UNAUTH") headers["cookie"] = cookie[id];
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

function assertEq(label: string, got: unknown, want: unknown): boolean {
  if (got === want) {
    pass++;
    console.log(`  ok   ${label} = ${got}`);
  } else {
    fail++;
    failures.push(`${label}: got ${got}, want ${want}`);
    console.log(`  FAIL ${label}: got ${got}, want ${want}`);
  }
  return got === want;
}

function assertTrue(label: string, cond: boolean, detail?: string): boolean {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
  return cond;
}

// ── DB fingerprint（寫入類 4xx 前後對照 — spec：「寫入類斷言 DB 冇變」）─────────
const FP_TABLES = [
  "Clinic", "Company", "StaffUser", "StaffClinic", "KnowledgeDoc", "RoutingRule",
  "SkillGroup", "SkillGroupClinic", "ConsultProduct", "ConsultSetting", "WorkflowDefinition",
  "FollowupRule", "FollowupTemplate", "SuggestionCard", "Alert", "AuditLog",
  "AutomationPolicy", "GoldenCase", "PushSubscription",
] as const;

async function dbFingerprint(): Promise<string> {
  const parts: string[] = [];
  for (const t of FP_TABLES) {
    const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`);
    parts.push(`${t}=${rows[0].n}`);
  }
  const ty = await prisma.$queryRawUnsafe<{ s: string }[]>(
    `SELECT code || '|' || name || '|' || coalesce("waPhoneNumberId", '') || '|' || coalesce("companyId", '') FROM "Clinic" WHERE code = 'TY'`
  );
  parts.push(`TY=${ty[0]?.s ?? "missing"}`);
  return parts.join(";");
}

const isWrite = (m: string) => m !== "GET" && m !== "HEAD";

// ── MATRIX（spec 形狀：Record<"METHOD /path", {fixture, expect}>）─────────────
// 格次序 = 執行次序：破壞性 200 格一定放喺同 route 嘅 403 格之後。
export const MATRIX: Record<string, { fixture: (f: Fixtures) => RequestInit & { url: string }; expect: Partial<Record<Id, number>>; note?: string }> = {
  // ═══ auth ═══
  "POST /api/auth/login": {
    fixture: () => ({ url: "/api/auth/login", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 400 }, // 快照：S3-5（TOTP）/ S3-6（rate limit）會改
  },
  "POST /api/auth/logout": {
    fixture: () => ({ url: "/api/auth/logout", method: "POST" }),
    expect: { UNAUTH: 200 }, // 快照：S3-2（登出只登出當前機 + denylist）會改
  },
  "POST /api/auth/change-password": {
    fixture: () => ({ url: "/api/auth/change-password", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 400 }, // 快照：S3-6（5/15min rate limit）會改
  },

  // ═══ 外部端點（唔經 RBAC — rbac.ts 檔頭註釋明列）═══
  "GET /api/wa/webhook": {
    fixture: () => ({ url: "/api/wa/webhook" }),
    expect: { UNAUTH: 403 }, // verify token 錯 = 403
  },
  "POST /api/wa/webhook": {
    fixture: () => ({ url: "/api/wa/webhook", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401 }, // signature 錯 = 401（快速拒）
  },
  "POST /api/flows/endpoint": {
    fixture: () => ({ url: "/api/flows/endpoint", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 400 }, // 快照：S3-8 會改（432 簽名 / 421 解密 / 427 token）
  },
  "GET /api/flows/endpoint": {
    fixture: () => ({ url: "/api/flows/endpoint" }),
    expect: { UNAUTH: 404 }, // ?key=healthz 先 200；快照：S3-8
  },
  "POST /api/internal/llm-extract": {
    fixture: () => ({ url: "/api/internal/llm-extract", method: "POST", body: JSON.stringify({ v: 1 }) }),
    expect: { UNAUTH: 401 }, // bad envelope（信封驗 — 唔係 RBAC cookie）
  },

  // ═══ admin — S3-1 target ═══
  "GET /api/admin/staff": {
    fixture: () => ({ url: "/api/admin/staff" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // T631 斷言 CB 可見範圍
  },
  "POST /api/admin/staff": {
    // 共用 body：STAFF + CLINICS[TY] — ALL 建到（201）；CB 建唔到（TY ⊄ B）= 403
    fixture: (f) => ({ url: "/api/admin/staff", method: "POST", body: JSON.stringify({
      email: "t630.newall@wa-clinic.local", name: "T630 New All", role: "STAFF",
      scopeType: "CLINICS", clinicIds: [f.clinicTY.id], password: PASS,
    }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 201 }, // T631 補 CB 建 YMT STAFF = 201
  },
  "PUT /api/admin/staff/[id]": {
    // target = staffDispo2（TY 店 STAFF — CB 外店 → 403；ALL 200 = 改名，零永久狀態改動）
    // ★ 唔好用 adminCompB 做 200 目標：升佢做 ALL scope 會污染後續所有 CB 格（T631 都紅）
    fixture: () => ({ url: `/api/admin/staff/${F.staffDispo2}`, method: "PUT", body: JSON.stringify({ name: "T630 renamed" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 }, // CB 改自己 = 403 喺 T631（spec 例）
  },
  "DELETE /api/admin/staff/[id]": {
    // dispo 一次性：CB 403 先（目標喺 TW — 其實係 CB scope 內 → 會 200！）
    // → 唔得：dispo 改放 TY 店先做得到 CB 403。
    fixture: () => ({ url: `/api/admin/staff/${F.staffDispo}`, method: "DELETE" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 }, // 見 setup：dispo 係 TY 店
  },

  "GET /api/admin/clinics": {
    fixture: () => ({ url: "/api/admin/clinics" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // T631 斷言 CB 可見集合
  },
  "POST /api/admin/clinics": {
    fixture: (f) => ({ url: "/api/admin/clinics", method: "POST", body: JSON.stringify({
      code: "T630X", name: "T630 API Clinic", waPhoneNumberId: "wa_ph_630x", waDisplayNumber: "+852 0000 630",
      companyId: f.companyB.id,
    }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 201 }, // 一次性（cleanup 刪）
  },
  "GET /api/admin/clinics/[id]": {
    fixture: (f) => ({ url: `/api/admin/clinics/${f.clinicTY.id}` }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 403 }, // scope filter
  },
  "PUT /api/admin/clinics/[id]": {
    // spec 例子：TY → 公司 B（critical：companyId 改動 → AuditLog CLINIC_CRITICAL_CHANGE + Alert HIGH）
    // 次序：CB 403 先；ALL 200 之後 matrix 尾還原 TY.companyId
    fixture: (f) => ({ url: `/api/admin/clinics/${f.clinicTY.id}`, method: "PUT", body: JSON.stringify({ companyId: f.companyB.id }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 },
  },
  "PATCH /api/admin/clinics/[id]": {
    fixture: (f) => ({ url: `/api/admin/clinics/${f.clinicTY.id}`, method: "PATCH", body: JSON.stringify({ companyId: f.companyB.id }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 },
  },
  "DELETE /api/admin/clinics/[id]": {
    fixture: () => ({ url: `/api/admin/clinics/${F.clinicDispo}`, method: "DELETE" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 }, // dispo 一次性
  },

  "GET /api/admin/companies": {
    fixture: () => ({ url: "/api/admin/companies" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 403 },
  },
  "GET /api/admin/company-sync": {
    fixture: () => ({ url: "/api/admin/company-sync" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 403 },
  },
  "POST /api/admin/company-sync": {
    fixture: () => ({ url: "/api/admin/company-sync", method: "POST" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 }, // mock 同步（A/B/C 冪等）
  },
  "POST /api/admin/company-sync/pair": {
    fixture: () => ({ url: "/api/admin/company-sync/pair", method: "POST", body: JSON.stringify({ companyId: "nope", sourceId: "nope" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 404 }, // 有效 body + company 唔存在 = 404（400 只係缺欄）
  },
  "POST /api/admin/onboarding/exchange": {
    fixture: () => ({ url: "/api/admin/onboarding/exchange", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 400 }, // 快照：S3-9（encodeURIComponent）
  },

  "GET /api/admin/knowledge": {
    fixture: () => ({ url: "/api/admin/knowledge" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // configReadWhere
  },
  "POST /api/admin/knowledge": {
    fixture: (f) => ({ url: "/api/admin/knowledge", method: "POST", body: JSON.stringify({
      clinicId: f.clinicF.id, kind: "FAQ", title: "T630 FAQ", keywords: ["t630"], body: "fixture", disclaimer: null, priceMin: null, priceMax: null,
    }) }), // priceMin/priceMax nullable 但必顯式提供（zod）— 唔送 = 400
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 }, // create = 200（非 201）；各建各嘅（無 dedupe）
  },
  "PUT /api/admin/knowledge/[id]": {
    // kdocF 喺 TY 店（跨公司）：CB 403 先，ALL 200（no-op 同內容 — version+1）
    // 完整 body（PUT = 整條更新；priceMin/priceMax nullable 但必顯式提供 — zod）
    fixture: (f) => ({ url: `/api/admin/knowledge/${F.kdocF}`, method: "PUT", body: JSON.stringify({
      clinicId: f.clinicTY.id, kind: "FAQ", title: "T630 FAQ", keywords: ["t630"], body: "fixture", disclaimer: null, priceMin: null, priceMax: null,
    }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 },
  },
  "DELETE /api/admin/knowledge/[id]": {
    fixture: () => ({ url: `/api/admin/knowledge/${F.kdocF}`, method: "DELETE" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 }, // 一次性
  },

  "GET /api/admin/routing-rules": {
    fixture: () => ({ url: "/api/admin/routing-rules" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "POST /api/admin/routing-rules": {
    fixture: (f) => ({ url: "/api/admin/routing-rules", method: "POST", body: JSON.stringify({
      name: "T630 rule", clinicId: f.clinicF.id, priority: 99, enabled: true, intents: [], keywords: [],
      patientType: null, treatmentTypes: [], targetType: "CLINIC_POOL", targetGroupId: null,
      targetStaffId: null, autoReplyTemplate: null, escalateAfterMin: null, escalateToGroupId: null,
    }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 409 }, // create = 200（非 201）；同名同店 → 409（CB 先建、ALL 撞 dup）
  },
  "PATCH /api/admin/routing-rules/[id]": {
    // target = 第一次建嘅 T630 rule（F 診所）— dynamic capture
    fixture: () => ({ url: `/api/admin/routing-rules/${created.routing[0] ?? "t630nope0000000000000001"}`, method: "PATCH", body: JSON.stringify({ priority: 99 }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 },
  },
  "POST /api/admin/routing-rules/reorder": {
    fixture: () => ({ url: "/api/admin/routing-rules/reorder", method: "POST", body: JSON.stringify({ clinicId: null, orderedIds: ["nope1", "nope2"] }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 400 }, // 逐條 assertConfigScope（400 = 先校驗 orderedIds）
  },
  "DELETE /api/admin/routing-rules/[id]": {
    // target = F.ruleTy（TY 店）：CB 403（外店）；ALL 200（一次性刪）
    fixture: () => ({ url: `/api/admin/routing-rules/${F.ruleTy}`, method: "DELETE" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 },
  },

  "GET /api/admin/skill-groups": {
    fixture: () => ({ url: "/api/admin/skill-groups" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "POST /api/admin/skill-groups": {
    fixture: (f) => ({ url: "/api/admin/skill-groups", method: "POST", body: JSON.stringify({ name: "T630 group", clinicIds: [f.clinicF.id] }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 }, // create = 200（非 201）；code 自動生成（衝突會加碼）
  },
  "PATCH /api/admin/skill-groups/[id]": {
    fixture: () => ({ url: `/api/admin/skill-groups/${created.skill[0] ?? "t630nope0000000000000001"}`, method: "PATCH", body: JSON.stringify({ description: "t630" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 },
  },
  "DELETE /api/admin/skill-groups/[id]": {
    fixture: () => ({ url: `/api/admin/skill-groups/${created.skill[0] ?? "t630nope0000000000000001"}`, method: "DELETE" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 }, // 刪組 = global only
  },

  "GET /api/admin/consult-products": {
    fixture: () => ({ url: "/api/admin/consult-products" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "POST /api/admin/consult-products": {
    fixture: (f) => ({ url: "/api/admin/consult-products", method: "POST", body: JSON.stringify({
      clinicId: f.clinicF.id, workflow: "ORTHODONTIC_CONSULT", code: "T630P", displayName: "T630 Product",
      category: "FIXED", positioning: "t630 定位", approvedWording: "t630 可以照講",
    }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 201, ADMIN_ALL: 409 }, // unique(clinicId,workflow,code) — CB 先建
  },
  "PUT /api/admin/consult-products/[id]": {
    fixture: () => ({ url: `/api/admin/consult-products/${created.product[0] ?? "t630nope0000000000000001"}`, method: "PUT", body: JSON.stringify({ positioning: "t630 定位 v2" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 },
  },
  "GET /api/admin/consult-products/[id]": {
    // target = created.product[0]（F 診所 — CB 自己店）
    fixture: () => ({ url: `/api/admin/consult-products/${created.product[0] ?? "t630nope0000000000000001"}` }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 },
  },
  "PATCH /api/admin/consult-products/[id]": {
    // 啟用/停用（冪等）
    fixture: () => ({ url: `/api/admin/consult-products/${created.product[0] ?? "t630nope0000000000000001"}`, method: "PATCH", body: JSON.stringify({ enabled: true }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 },
  },
  "POST /api/admin/consult-products/[id]/approve": {
    fixture: () => ({ url: `/api/admin/consult-products/${created.product[0] ?? "t630nope0000000000000001"}/approve`, method: "POST", body: JSON.stringify({ approvedBy: "t630" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 }, // assertConfigScope(product.clinicId)；冪等
  },

  "GET /api/admin/consult-settings": {
    fixture: () => ({ url: "/api/admin/consult-settings" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // configReadWhere
  },
  "PUT /api/admin/consult-settings": {
    // 店層（F 診所）：CB 200（自己店）；ALL 200（冪等 upsert 同一行）
    // 全局層（clinicId null）→ CB 403 = T631 斷言
    fixture: (f) => ({ url: "/api/admin/consult-settings", method: "PUT", body: JSON.stringify({ clinicId: f.clinicF.id, key: "rules", value: RULES_VALUE }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 },
  },

  "POST /api/admin/consult/preview": {
    // clinicId 唔送 = null（全局）→ global only：CB 403
    fixture: () => ({ url: "/api/admin/consult/preview", method: "POST", body: JSON.stringify({ workflow: "ORTHODONTIC_CONSULT", demoQuestion: "t630" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 },
  },

  "GET /api/admin/workflows": {
    fixture: () => ({ url: "/api/admin/workflows" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "PUT /api/admin/workflows/[key]": {
    // clinicId = TY（CB 外店）：CB 403；ALL 201（draft — 非 ACTIVE = 零運行影響；cleanup 刪）
    fixture: (f) => ({ url: "/api/admin/workflows/triage", method: "PUT", body: JSON.stringify({ clinicId: f.clinicTY.id, params: TRIAGE_PARAMS }) }), // params 必過 TriageParams 校驗（saveDraft 否則 400）
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 201 },
  },
  "POST /api/admin/workflows/[key]/publish": {
    // 唔存在 defId → 404（scope 檢查喺 find 之後）— 零狀態改動
    // （publish 嘅 scope 403 喺 T631 用 transient 全局 draft 斷言）
    fixture: () => ({ url: "/api/admin/workflows/triage/publish", method: "POST", body: JSON.stringify({ defId: "t630nope0000000000000001" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 404, ADMIN_ALL: 404 },
  },
  "POST /api/admin/workflows/[key]/revert": {
    // clinicId = TY：CB 403（scope 檢查喺 store 之前）；ALL 404（version 99 唔可能存在）
    fixture: (f) => ({ url: "/api/admin/workflows/triage/revert", method: "POST", body: JSON.stringify({ clinicId: f.clinicTY.id, toVersion: 99 }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 404 },
  },
  "GET /api/admin/workflows/[key]/versions": {
    fixture: () => ({ url: "/api/admin/workflows/triage/versions" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },

  "GET /api/admin/followups/rules": {
    fixture: () => ({ url: "/api/admin/followups/rules" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "PATCH /api/admin/followups/rules/[id]": {
    // setup 建嘅店規則（F 診所）：CB 200（自己店）；ALL 200
    fixture: () => ({ url: `/api/admin/followups/rules/${F.followupRule}`, method: "PATCH", body: JSON.stringify({ enabled: true }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 },
  },
  "GET /api/admin/followups/templates": {
    fixture: () => ({ url: "/api/admin/followups/templates" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // gen2 口徑：UI 需要（偏離清單）
  },
  "POST /api/admin/followups/templates": {
    // 全局 registry → global only
    fixture: (f) => ({ url: "/api/admin/followups/templates", method: "POST", body: JSON.stringify({ key: f.followupTemplate.key }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 }, // 冪等 approve（teardown 還原）
  },

  "GET /api/admin/automation": {
    fixture: () => ({ url: "/api/admin/automation" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 200, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // 讀：scope filter
  },
  "PATCH /api/admin/automation": {
    // TY 店：CB 403（外店）；SUP 200（全店語義 — spec 例外）；ALL 200
    // 寫入 TY/BOOKING_REQUEST=L2 — teardown 還原原 policy
    fixture: (f) => ({ url: "/api/admin/automation", method: "PATCH", body: JSON.stringify({ clinicId: f.clinicTY.id, category: "BOOKING_REQUEST", level: "L2" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, ADMIN_COMPANY_B: 403, SUPERVISOR: 200, ADMIN_ALL: 200 },
  },

  "GET /api/admin/alerts": {
    fixture: () => ({ url: "/api/admin/alerts" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "POST /api/admin/alerts/[id]/resolve": {
    // alertF 喺 F 診所（CB scope 內）：CB 200 先（冪等），ALL 200
    fixture: () => ({ url: `/api/admin/alerts/${F.alertF}/resolve`, method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 },
  },
  "POST /api/admin/hold-sweep": {
    fixture: () => ({ url: "/api/admin/hold-sweep", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 }, // 全集團 sweep → global only
  },

  "GET /api/admin/ai-status": {
    fixture: () => ({ url: "/api/admin/ai-status" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // gen4：scoped ADMIN clinics filter
  },

  "GET /api/admin/suggestions": {
    fixture: () => ({ url: "/api/admin/suggestions" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 200, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // requireAdminOrSupervisor（S3-1 target：SUP 讀）
  },
  "POST /api/admin/suggestions/[id]/decide": {
    // suggF 喺 F 診所（CB scope 內）：CB 200 先（冪等 reject），ALL 200
    fixture: () => ({ url: `/api/admin/suggestions/${F.suggF}/decide`, method: "POST", body: JSON.stringify({ decision: "REJECTED" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 409 }, // CB 先 decide → ALL 第二次 = 409（state machine）
  },

  // ═══ admin — 快照（D2/D3/D4）═══
  "GET /api/admin/quotes": {
    fixture: () => ({ url: "/api/admin/quotes" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, STAFF_YMT: 200, SUPERVISOR: 200, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // 快照：STAFF_TY 只見 TY（T631 附帶斷言）
  },
  "POST /api/admin/quotes": {
    fixture: () => ({ url: "/api/admin/quotes", method: "POST", body: JSON.stringify({ id: "nope", action: "confirm" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 404, ADMIN_COMPANY_B: 403 }, // 受限角色 = 403（scope filter 先行）；ALL = 404（workforce 搵唔到）
  },
  "GET /api/admin/ai": {
    fixture: () => ({ url: "/api/admin/ai" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 200, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "GET /api/admin/ai/keywords": {
    fixture: () => ({ url: "/api/admin/ai/keywords?q=t630" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 200, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "GET /api/admin/ai/keywords/impact": {
    fixture: () => ({ url: "/api/admin/ai/keywords/impact?term=t630" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 200, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "POST /api/admin/ai-sandbox/run": {
    fixture: () => ({ url: "/api/admin/ai-sandbox/run", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 400, ADMIN_ALL: 400 }, // invalid body = 400 validation-first（scope 403 喺 T631 §8 用有效 body 斷）
  },
  "POST /api/admin/ai-sandbox/reset": {
    fixture: () => ({ url: "/api/admin/ai-sandbox/reset", method: "POST", body: JSON.stringify({ sandboxId: "t630-none" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 }, // 無 scope 分拆（任何 ADMIN 可 reset 任何 sandboxId — S3-x 審視項）
  },
  "GET /api/admin/followup-hub": {
    fixture: () => ({ url: "/api/admin/followup-hub" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 200, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "GET /api/admin/usage": {
    fixture: () => ({ url: "/api/admin/usage" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 },
  },
  "POST /api/admin/dead-letters/replay": {
    fixture: () => ({ url: "/api/admin/dead-letters/replay", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 }, // 無 id filter 無 scope 分拆（replay 全部 pending — 0 件 = no-op；S3-x 審視項）
  },
  "POST /api/admin/totp/enroll": {
    fixture: () => ({ url: "/api/admin/totp/enroll", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 }, // 快照：enroll = 自助（無 scope 分拆；S3-5 會改 password+confirm）；teardown 刪 fixture 用戶
  },

  // ═══ S3-4：術語字典 ═══
  "GET /api/admin/clinical-terms": {
    fixture: () => ({ url: "/api/admin/clinical-terms" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, STAFF_YMT: 200, SUPERVISOR: 200, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // 讀：全部員工
  },
  "PUT /api/admin/clinical-terms": {
    fixture: () => ({ url: "/api/admin/clinical-terms", method: "PUT", body: JSON.stringify({ terms: [{ shorthand: "T630", nameCn: "矩陣測試", active: true }] }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 }, // T638 全 6 斷言另跑
  },

  // ═══ staff-facing（快照 — D2/D3/D4；核心格 = UNAUTH 401 + STAFF 邊界）═══
  "POST /api/availability/refresh": {
    fixture: () => ({ url: "/api/availability/refresh", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 400 }, // 快照：S3-9（clinicId 參數）
  },
  "POST /api/bookings/[id]/confirm": {
    fixture: () => ({ url: "/api/bookings/nope/confirm", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-3（send lock）
  },
  "POST /api/bookings/[id]/create": {
    fixture: () => ({ url: "/api/bookings/nope/create", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/bookings/[id]/reschedule": {
    fixture: () => ({ url: "/api/bookings/nope/reschedule", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-3（send lock）
  },
  "POST /api/bookings/[id]/rollback": {
    fixture: () => ({ url: "/api/bookings/nope/rollback", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/bookings/manual": {
    fixture: () => ({ url: "/api/bookings/manual", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 400 }, // 快照：S3-9（providerApricotId 核對）
  },
  "GET /api/bookings": {
    fixture: () => ({ url: "/api/bookings" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "GET /api/clinics": {
    fixture: () => ({ url: "/api/clinics?scope=schedule" }), // ?scope=schedule 必填（否則 400）
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "PATCH /api/contacts/[id]": {
    fixture: () => ({ url: "/api/contacts/nope", method: "PATCH", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-3（assertCanWriteConversation）
  },
  "POST /api/conversations/[id]/app-handoff": {
    fixture: () => ({ url: "/api/conversations/nope/app-handoff", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-3
  },
  "POST /api/conversations/[id]/assign": {
    fixture: () => ({ url: "/api/conversations/nope/assign", method: "POST", body: JSON.stringify({ toStaffId: null }) }), // 有效 body（toStaffId nullable）→ 404 喺 conv lookup
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/conversations/[id]/consult-sessions": {
    fixture: () => ({ url: "/api/conversations/nope/consult-sessions" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/conversations/[id]/consult-sessions": {
    fixture: () => ({ url: "/api/conversations/nope/consult-sessions", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "PATCH /api/conversations/[id]/consult-sessions": {
    fixture: () => ({ url: "/api/conversations/nope/consult-sessions", method: "PATCH", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "PATCH /api/conversations/[id]/drafts/[draftId]": {
    fixture: () => ({ url: "/api/conversations/nope/drafts/nope", method: "PATCH", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "DELETE /api/conversations/[id]/drafts/[draftId]": {
    fixture: () => ({ url: "/api/conversations/nope/drafts/nope", method: "DELETE" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/conversations/[id]/drafts": {
    fixture: () => ({ url: "/api/conversations/nope/drafts" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/conversations/[id]/flag": {
    fixture: () => ({ url: "/api/conversations/nope/flag", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-3
  },
  "POST /api/conversations/[id]/flows": {
    fixture: () => ({ url: "/api/conversations/nope/flows", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-3（ADMIN 豁免刪）+ S3-8
  },
  "GET /api/conversations/[id]/messages": {
    fixture: () => ({ url: "/api/conversations/nope/messages" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/conversations/[id]/note-read-receipts": {
    fixture: () => ({ url: "/api/conversations/nope/note-read-receipts" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/conversations/[id]/notes": {
    fixture: () => ({ url: "/api/conversations/nope/notes", method: "POST", body: JSON.stringify({ body: "t630" }) }), // 有效 body → 404 喺 conv lookup
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/conversations/[id]/patient-appointments/cancel": {
    fixture: () => ({ url: "/api/conversations/nope/patient-appointments/cancel", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/conversations/[id]/patient-appointments/reschedule": {
    fixture: () => ({ url: "/api/conversations/nope/patient-appointments/reschedule", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/conversations/[id]/patient-context": {
    fixture: () => ({ url: "/api/conversations/nope/patient-context" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/conversations/[id]/patient-pin": {
    fixture: () => ({ url: "/api/conversations/nope/patient-pin", method: "POST", body: JSON.stringify({ patientApricotId: "t630apr", patientName: "t630" }) }), // 有效 body → 404 喺 conv lookup
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-3
  },
  "DELETE /api/conversations/[id]/patient-pin": {
    fixture: () => ({ url: "/api/conversations/nope/patient-pin", method: "DELETE" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-3
  },
  "GET /api/conversations/[id]/patient-record/note": {
    fixture: () => ({ url: "/api/conversations/nope/patient-record/note" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/conversations/[id]/patient-record": {
    fixture: () => ({ url: "/api/conversations/nope/patient-record" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/conversations/[id]": {
    fixture: () => ({ url: "/api/conversations/nope" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "PATCH /api/conversations/[id]": {
    fixture: () => ({ url: "/api/conversations/nope", method: "PATCH", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/conversations/[id]/templates": {
    fixture: () => ({ url: "/api/conversations/nope/templates" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/conversations": {
    fixture: () => ({ url: "/api/conversations" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "GET /api/dictionaries": {
    fixture: () => ({ url: "/api/dictionaries?kind=VISIT_REASON" }), // ?kind= 必填（VISIT_REASON|BOOKING_TYPE）
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "GET /api/duty-roster": {
    fixture: () => ({ url: "/api/duty-roster?clinicId=TY" }), // clinicId 參數 = 店 CODE（唔係 id）— STAFF 參數必同自己店 code 一致；ADMIN 按 code 搵店
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "POST /api/flows/holds/[id]/commit": {
    fixture: () => ({ url: "/api/flows/holds/nope/commit", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/flows/slots": {
    // clinicCode+from+to（YYYY-MM-DD，from>=今日，span≤7）必填 — 本地日期算（server TZ 同源）
    fixture: () => {
      const iso = (off: number) => {
        const x = new Date(Date.now() + off * 86400_000);
        return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      };
      return { url: `/api/flows/slots?clinicCode=TY&from=${iso(0)}&to=${iso(1)}` };
    },
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "PATCH /api/followups/contacts/[id]/opt-out": {
    fixture: () => ({ url: "/api/followups/contacts/nope/opt-out", method: "PATCH", body: JSON.stringify({ optOut: true }) }), // optOut:boolean 必填 → 404 喺 contact lookup
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/followups/tasks/[id]": {
    fixture: () => ({ url: "/api/followups/tasks/nope", method: "POST", body: JSON.stringify({ action: "skip" }) }), // action=send|skip 必填 → 404 喺 task lookup
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-3（SUPERVISOR skip 已 S0-5 擋）
  },
  "GET /api/followups/tasks": {
    fixture: () => ({ url: "/api/followups/tasks" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "PUT /api/golden-cases/[id]": {
    fixture: () => ({ url: `/api/golden-cases/${F.goldenF}`, method: "PUT", body: JSON.stringify({ enabled: false }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 200, ADMIN_ALL: 200 }, // assertConfigScope(existing.clinicId) — F 診所
  },
  "DELETE /api/golden-cases/[id]": {
    // target = goldenTy（TY 店 = CB 外店）：CB 403（scope）；ALL 200（一次性刪）
    fixture: () => ({ url: `/api/golden-cases/${F.goldenTy}`, method: "DELETE" }),
    expect: { UNAUTH: 401, STAFF_TY: 403, STAFF_YMT: 403, SUPERVISOR: 403, ADMIN_COMPANY_B: 403, ADMIN_ALL: 200 },
  },
  "GET /api/golden-cases/prefill": {
    // fixture msg = IN text @ F 店（STAFF_TY 外店）：STAFF_TY 403（conversation access）；ALL 200
    fixture: () => ({ url: `/api/golden-cases/prefill?messageId=${F.msgPre}` }),
    expect: { UNAUTH: 401, STAFF_TY: 403, ADMIN_ALL: 200 },
  },
  "GET /api/golden-cases": {
    fixture: () => ({ url: "/api/golden-cases" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200, ADMIN_COMPANY_B: 200 }, // requireAuth（STAFF 可睇 list — base 語義）
  },
  "POST /api/golden-cases": {
    // 有效 body + clinicId = F 店：STAFF（TY 外店）403；SUP/CB/ALL 201（建入 F 店 — teardown 按 clinicId 洗）
    // （invalid body {} = 全部 400 validation-first — 測唔到 scope 格，所以用有效 body）
    fixture: (f) => ({ url: "/api/golden-cases", method: "POST", body: JSON.stringify({ clinicId: f.clinicF.id, utterance: "t630 matrix", expectIntent: "OTHER" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 403, SUPERVISOR: 201, ADMIN_COMPANY_B: 201, ADMIN_ALL: 201 },
  },
  "GET /api/media/[file]": {
    fixture: () => ({ url: "/api/media/nope.png" }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "POST /api/messages/[id]/void": {
    fixture: () => ({ url: "/api/messages/nope/void", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 }, // 快照：S3-9（assertConversationAccess 先行）
  },
  "POST /api/messages/send": {
    fixture: () => ({ url: "/api/messages/send", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 400 }, // 快照：S3-9（replay lookup + send lock 順序）
  },
  "POST /api/notes/[id]/read": {
    fixture: () => ({ url: "/api/notes/nope/read", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 404 },
  },
  "GET /api/notices": {
    fixture: () => ({ url: "/api/notices" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "PATCH /api/notices": {
    fixture: () => ({ url: "/api/notices", method: "PATCH", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401 }, // 快照：S3-3（assertCanWriteConversation）
  },
  "GET /api/push/prefs": {
    fixture: () => ({ url: "/api/push/prefs" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "POST /api/push/prefs": {
    // 角色分離：STAFF 收 mutedClinics / ADMIN 收 adminMsgClinics — 兩邊都送（各取各嘅，外角色欄位被忽略+warn）
    fixture: () => ({ url: "/api/push/prefs", method: "POST", body: JSON.stringify({ mutedClinics: [], adminMsgClinics: [] }) }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "POST /api/push/subscribe": {
    fixture: () => ({ url: "/api/push/subscribe", method: "POST", body: JSON.stringify({ endpoint: "https://example.com/ep", keys: { p256dh: "x", auth: "y" }, user: "u" }) }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 }, // 快照：S3-7（allowlist 會改 → 400）；teardown 清 PushSubscription
  },
  "POST /api/push/test": {
    fixture: () => ({ url: "/api/push/test", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 200 }, // 單店 STAFF 自動填 clinicId → 200（400 = 多店受限角色唔送 clinicId）
  },
  "POST /api/push/unsubscribe": {
    fixture: () => ({ url: "/api/push/unsubscribe", method: "POST", body: JSON.stringify({}) }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "GET /api/push/vapid-key": {
    fixture: () => ({ url: "/api/push/vapid-key" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 },
  },
  "GET /api/search": {
    fixture: () => ({ url: "/api/search?q=t630" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 }, // 快照：S3-6（30/min rate limit）
  },
  "GET /api/staff": {
    fixture: () => ({ url: "/api/staff" }),
    expect: { UNAUTH: 401, STAFF_TY: 200, ADMIN_ALL: 200 }, // 快照：S3-9（clinicId filter）
  },
};

// ── route 掃描（spec：export const (GET|POST|PUT|PATCH|DELETE)）────────────────
function discoverRoutes(): Set<string> {
  const found = new Set<string>();
  const files = listRouteFiles(path.join(process.cwd(), "src/app/api")).map((f) => path.relative(process.cwd(), f));
  const methodRe = /export\s+(?:const\s+(GET|POST|PUT|PATCH|DELETE)\s*=|(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\()/g;
  for (const file of files) {
    const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const rel = file.replace(/^src\/app\/api\//, "").replace(/\/route\.ts$/, "");
    const p = rel ? `/api/${rel}` : "/api";
    let m: RegExpExecArray | null;
    methodRe.lastIndex = 0;
    while ((m = methodRe.exec(src)) !== null) {
      found.add(`${m[1] ?? m[2]} ${p}`);
    }
  }
  return found;
}

// ── setup / teardown（T750 pattern）────────────────────────────────────────
async function purgeFixtureRows() {
  // 重跑冪等：先洗走上一輪殘留
  await prisma.staffUser.deleteMany({ where: { email: { in: TEST_EMAILS } } });
  await prisma.staffUser.deleteMany({ where: { id: { in: Object.values(F) } } });
  await prisma.staffClinic.deleteMany({ where: { staffId: { in: Object.values(F) } } });
  for (const cid of [F.clinicF, F.clinicDispo]) {
    await prisma.automationPolicy.deleteMany({ where: { clinicId: cid } });
    await prisma.consultSetting.deleteMany({ where: { clinicId: cid } });
    await prisma.knowledgeDoc.deleteMany({ where: { clinicId: cid } });
    await prisma.routingRule.deleteMany({ where: { clinicId: cid } });
    await prisma.skillGroupClinic.deleteMany({ where: { clinicId: cid } });
    await prisma.workflowDefinition.deleteMany({ where: { clinicId: cid } });
    await prisma.consultProduct.deleteMany({ where: { clinicId: cid } });
    await prisma.goldenCase.deleteMany({ where: { clinicId: cid } });
    await prisma.suggestionCard.deleteMany({ where: { clinicId: cid } });
    await prisma.followupRule.deleteMany({ where: { clinicId: cid } });
    await prisma.alert.deleteMany({ where: { clinicId: cid } });
  }
  await prisma.clinic.deleteMany({ where: { id: { in: [F.clinicF, F.clinicDispo] } } });
  await prisma.clinic.deleteMany({ where: { code: { in: ["T630F", "T630D", "T630X"] } } });
  await prisma.knowledgeDoc.deleteMany({ where: { id: F.kdocF } });
  await prisma.goldenCase.deleteMany({ where: { id: F.goldenF } });
  await prisma.goldenCase.deleteMany({ where: { id: F.goldenTy } });
  await prisma.message.deleteMany({ where: { id: F.msgPre } });
  await prisma.conversation.deleteMany({ where: { id: F.convPre } });
  await prisma.contact.deleteMany({ where: { waId: "8526300001" } });
  await prisma.alert.deleteMany({ where: { id: F.alertF } });
  await prisma.suggestionCard.deleteMany({ where: { id: F.suggF } });
  await prisma.followupRule.deleteMany({ where: { id: F.followupRule } });
  await prisma.routingRule.deleteMany({ where: { id: F.ruleTy } });
  await prisma.workflowDefinition.deleteMany({ where: { id: F.publishDef } });
}

async function setup(): Promise<Fixtures> {
  const pw = await argon2.hash(PASS);
  await purgeFixtureRows();

  const clinic = await prisma.clinic.findMany({ where: { code: { in: ["TY", "YMT", "TW", "MF"] } }, select: { id: true, code: true, companyId: true } });
  const companyB = await prisma.company.findFirst({ where: { code: "B" }, select: { id: true } });
  if (!companyB) throw new Error("company B 唔存在");
  const by = (code: string) => clinic.find((c) => c.code === code)!;
  if (!by("TY") || !by("YMT") || !by("TW") || !by("MF")) throw new Error("TY/YMT/TW/MF 診所唔齊");
  clinicTyOriginal = { companyId: by("TY").companyId };

  // 5 fixture 用戶（upsert 冪等）
  const emails: Record<string, string> = {
    [F.staffTy]: "t630.staff.ty@wa-clinic.local",
    [F.staffYmt]: "t630.staff.ymt@wa-clinic.local",
    [F.supervisor]: "t630.supervisor@wa-clinic.local",
    [F.adminAll]: "t630.admin.all@wa-clinic.local",
    [F.adminCompB]: "t630.admin.compB@wa-clinic.local",
  };
  const mk = (id: string, role: string, scopeType: string | null, scopeCompanyId: string | null, clinicIds: string[]) => {
    const r = role as Role;
    const cl = scopeType === "CLINICS" ? (clinicIds[0] ?? null) : null;
    // Prisma：update 設 null 用 DbNull；create 用 conditional spread 略過 null 欄
    return prisma.staffUser.upsert({
      where: { id },
      update: { role: r, scopeType: scopeType ?? undefined, scopeCompanyId, clinicId: cl, active: true, passwordHash: pw },
      create: {
        id, email: emails[id],
        name: `T630 ${r} ${scopeType ?? "ALL"}`,
        role: r, scopeType: scopeType ?? undefined,
        ...(scopeCompanyId !== null ? { scopeCompanyId } : {}),
        ...(cl !== null ? { clinicId: cl } : {}),
        active: true, passwordHash: pw,
      },
    });
  };
  await mk(F.staffTy, "STAFF", "CLINICS", null, [by("TY").id]);
  await mk(F.staffYmt, "STAFF", "CLINICS", null, [by("YMT").id]);
  await mk(F.supervisor, "SUPERVISOR", "ALL", null, []);
  await mk(F.adminAll, "ADMIN", "ALL", null, []);
  await mk(F.adminCompB, "ADMIN", "COMPANY", companyB.id, []);
  for (const [uid, cids] of [[F.staffTy, [by("TY").id]], [F.staffYmt, [by("YMT").id]]] as const) {
    await prisma.staffClinic.deleteMany({ where: { staffId: uid } });
    await prisma.staffClinic.createMany({ data: cids.map((cid, i) => ({ staffId: uid, clinicId: cid, isPrimary: i === 0 })) });
  }
  adminCompBOriginal = await prisma.staffUser.findUniqueOrThrow({ where: { id: F.adminCompB }, select: { role: true, scopeType: true, scopeCompanyId: true, clinicId: true } });

  // DELETE 200 一次性 staff — STAFF CLINICS[TY]（CB 外店 → DELETE 403 先跑，ALL 先刪）
  await prisma.staffUser.upsert({
    where: { id: F.staffDispo },
    update: { active: true, passwordHash: pw },
    create: { id: F.staffDispo, email: "t630.dispo@wa-clinic.local", name: "T630 Dispo", role: "STAFF", scopeType: "CLINICS", clinicId: by("TY").id, active: true, passwordHash: pw },
  });
  await prisma.staffClinic.deleteMany({ where: { staffId: F.staffDispo } });
  await prisma.staffClinic.create({ data: { staffId: F.staffDispo, clinicId: by("TY").id, isPrimary: true } });
  // PUT 200 一次性 staff — STAFF CLINICS[TY]
  await prisma.staffUser.upsert({
    where: { id: F.staffDispo2 },
    update: { active: true, passwordHash: pw, name: "T630 Dispo2", scopeType: "CLINICS", clinicId: by("TY").id },
    create: { id: F.staffDispo2, email: "t630.dispo2@wa-clinic.local", name: "T630 Dispo2", role: "STAFF", scopeType: "CLINICS", clinicId: by("TY").id, active: true, passwordHash: pw },
  });
  await prisma.staffClinic.deleteMany({ where: { staffId: F.staffDispo2 } });
  await prisma.staffClinic.create({ data: { staffId: F.staffDispo2, clinicId: by("TY").id, isPrimary: true } });

  // 主 fixture 診所（公司 B）+ 一次性診所（waPhoneNumberId 必不同 — unique）
  for (const [cid, code, ph] of [[F.clinicF, "T630F", "wa_ph_630"], [F.clinicDispo, "T630D", "wa_ph_631"]] as const) {
    await prisma.clinic.upsert({
      where: { id: cid },
      update: {},
      create: { id: cid, code, name: "T630 Clinic", waPhoneNumberId: ph, waDisplayNumber: "+852 0000 630", companyId: companyB.id },
    });
  }

  // knowledge doc（clinicId = TY — 跨公司）
  await prisma.knowledgeDoc.upsert({
    where: { id: F.kdocF },
    update: {},
    create: { id: F.kdocF, clinicId: by("TY").id, kind: "FAQ", title: "T630 FAQ", keywords: ["t630"], body: "fixture" },
  });

  // followup template（記住原狀 — POST approve 之後還原）
  const t = await prisma.followupTemplate.findFirst();
  if (!t) throw new Error("FollowupTemplate 全空");
  templateOriginal = { key: t.key, approved: t.approved, approvedAt: t.approvedAt, approvedBy: t.approvedBy, updatedAt: t.updatedAt, text: t.text };

  // followup rule（店規則 — F 診所）
  await prisma.followupRule.upsert({
    where: { id: F.followupRule },
    update: { enabled: true },
    create: {
      id: F.followupRule, clinicId: F.clinicF, name: "T630 rule", trigger: "CONVERSATION_IDLE",
      delayValue: 24, delayUnit: "HOUR", reasonCodes: [], templateName: t.key, level: "L1", maxSends: 1,
    },
  });

  // fixture rule — TY 店（DELETE 403 格用 — CB 外店）
  await prisma.routingRule.upsert({
    where: { id: F.ruleTy },
    update: {},
    create: {
      id: F.ruleTy, clinicId: by("TY").id, name: "T630 TY rule", priority: 98, enabled: true, intents: [], keywords: [],
      patientType: null, treatmentTypes: [], targetType: "CLINIC_POOL", targetGroupId: null, targetStaffId: null,
      autoReplyTemplate: null, escalateAfterMin: null, escalateToGroupId: null,
    },
  });

  // fixture alert（F 診所 → CB scope 內）
  await prisma.alert.upsert({
    where: { id: F.alertF },
    update: { resolvedAt: null },
    create: { id: F.alertF, type: "t630_test", severity: "MEDIUM", clinicId: F.clinicF, clinicCode: "T630F" },
  });

  // fixture suggestion card（F 診所）
  await prisma.suggestionCard.upsert({
    where: { id: F.suggF },
    update: { status: "PROPOSED", decidedBy: null, decidedAt: null },
    create: { id: F.suggF, clinicId: F.clinicF, kind: "FAQ", title: "T630 sugg", payload: {}, evidence: { counts: 0, samples: [] }, status: "PROPOSED" },
  });

  // fixture golden case（F 診所）
  await prisma.goldenCase.upsert({
    where: { id: F.goldenF },
    update: { enabled: true },
    create: { id: F.goldenF, clinicId: F.clinicF, source: "MANUAL", utterance: "t630", contextBefore: [], expectIntent: "OTHER" },
  });

  // TY 店 golden case（DELETE 格：CB 外店 403 / ALL 200 刪）
  await prisma.goldenCase.upsert({
    where: { id: F.goldenTy },
    update: { enabled: true },
    create: { id: F.goldenTy, clinicId: by("TY").id, source: "MANUAL", utterance: "t630 ty", contextBefore: [], expectIntent: "OTHER" },
  });

  // prefill fixture（F 店 = STAFF_TY 外店 → 403；ADMIN_ALL → 200）— Contact+Conversation+IN text Message
  await prisma.contact.upsert({
    where: { id: F.contactPre },
    update: {},
    create: { id: F.contactPre, clinicId: F.clinicF, waId: "8526300001", labels: [] },
  });
  await prisma.conversation.upsert({
    where: { id: F.convPre },
    update: {},
    create: { id: F.convPre, clinicId: F.clinicF, contactId: F.contactPre, lastMessageAt: new Date("2026-01-01T00:00:00.000Z") },
  });
  await prisma.message.upsert({
    where: { id: F.msgPre },
    update: {},
    create: { id: F.msgPre, conversationId: F.convPre, direction: "IN", channel: "API", type: "text", body: "t630 prefill fixture", status: "RECEIVED", waTimestamp: new Date("2026-01-01T00:00:00.000Z") },
  });

  // TY automation policy 快照（automation PATCH L2 之後還原）
  const tyPol = await prisma.automationPolicy.findUnique({ where: { clinicId_category: { clinicId: by("TY").id, category: "BOOKING_REQUEST" } } });
  tyPolicyOriginal = tyPol ? { level: tyPol.level } : null;

  // workforce clinical mock（file-backed）— symlink swap（T750 pattern）
  fs.mkdirSync(".dev", { recursive: true });
  fs.writeFileSync(MOCK_CLINICAL_SRC, JSON.stringify({
    terms: [
      // ★ gen7 修正：TermEntrySchema 必填 updatedAt（mock GET 直接回 file 內容 — 缺欄 = ZodError → 400）
      { id: "t630-1", shorthand: "F2", nameCn: "下排左第二前臼齒", nameEn: null, usedFor: ["quote_extraction"], active: true, updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "t630-2", shorthand: "M1", nameCn: "上排右第一臼齒", nameEn: null, usedFor: ["quote_extraction"], active: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
  }), "utf8");
  if (fs.existsSync(MOCK_CLINICAL)) {
    if (fs.lstatSync(MOCK_CLINICAL).isSymbolicLink()) fs.rmSync(MOCK_CLINICAL);
    else throw new Error(".dev/workforce-mock-clinical.json 已存在（非 symlink）— 人手核實先");
  }
  fs.symlinkSync(MOCK_CLINICAL_SRC, MOCK_CLINICAL);
  mockSymlinkCreated = true;

  // login 5 個 fixture（cookie）
  // ★ dev in-memory 限流 = 5 次/60s per client IP；clientIp 取 XFF 最後個值 → 每身份獨立 XFF bucket
  //   （prod 由 nginx 設真 IP；呢度只係 dev e2e 隔離計數 — 同 mock-e2e harness 口徑一致）
  const xffOf = (id: string) => `10.63.${Object.keys(emails).indexOf(id) + 1}.7`;
  const roleOf: Record<string, Id> = {
    [F.staffTy]: "STAFF_TY",
    [F.staffYmt]: "STAFF_YMT",
    [F.supervisor]: "SUPERVISOR",
    [F.adminAll]: "ADMIN_ALL",
    [F.adminCompB]: "ADMIN_COMPANY_B",
  };
  for (const [id, email] of Object.entries(emails)) {
    let ok = false, lastErr = "";
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const res = await fetch(BASE + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": xffOf(id) },
        body: JSON.stringify({ email, password: PASS }),
      });
      const txt = await res.text();
      if (res.status === 200) {
        const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=[^;]+/);
        if (m) { cookie[roleOf[id]] = m[0]; ok = true; } // ★ 以角色 Id 做 key（api() 以 Id 讀）
        else lastErr = "200 但冇 cookie";
      } else {
        lastErr = `${res.status} ${txt.slice(0, 120)}`;
      }
      if (!ok && attempt < 3) await new Promise((r) => setTimeout(r, 3000)); // dev loadManifest race（已知 flake）— 重試
    }
    if (!ok) throw new Error(`fixture login fail ${id}（3 次）: ${lastErr}`);
  }

  return {
    clinicTY: { id: by("TY").id },
    clinicYMT: { id: by("YMT").id },
    clinicTW: { id: by("TW").id },
    clinicMF: { id: by("MF").id },
    clinicF: { id: F.clinicF },
    companyB: { id: companyB.id },
    adminCompanyB: { id: F.adminCompB },
    staffTy: { id: F.staffTy },
    staffYmt: { id: F.staffYmt },
    followupTemplate: { key: t.key },
    prefillMsg: { id: F.msgPre },
  };
}

// ★ debug probe：setup 後即刻驗 5 個 cookie 有冇即刻死（定位 401 時間點）
async function probeCookies() {
  console.log("\n═══ cookie probe（setup 後即刻）═══");
  for (const id of ["STAFF_TY", "STAFF_YMT", "SUPERVISOR", "ADMIN_ALL", "ADMIN_COMPANY_B"] as Id[]) {
    const r = await api(id, "GET", "/api/staff");
    console.log(`  probe ${id}: ${r.status}（想 200）cookie=${(cookie[id] ?? "").slice(0, 30)}...`);
  }
}

async function teardown() {
  try {
    // API 建嘅產物
    for (const id of created.staff) await prisma.staffUser.deleteMany({ where: { id } });
    for (const id of created.clinic) {
      await prisma.automationPolicy.deleteMany({ where: { clinicId: id } });
      await prisma.consultSetting.deleteMany({ where: { clinicId: id } });
      await prisma.knowledgeDoc.deleteMany({ where: { clinicId: id } });
      await prisma.routingRule.deleteMany({ where: { clinicId: id } });
      await prisma.skillGroupClinic.deleteMany({ where: { clinicId: id } });
      await prisma.workflowDefinition.deleteMany({ where: { clinicId: id } });
      await prisma.consultProduct.deleteMany({ where: { clinicId: id } });
      await prisma.clinic.deleteMany({ where: { id } });
    }
    for (const id of created.kdoc) await prisma.knowledgeDoc.deleteMany({ where: { id } });
    for (const id of created.routing) await prisma.routingRule.deleteMany({ where: { id } });
    for (const id of created.skill) {
      await prisma.skillGroupClinic.deleteMany({ where: { groupId: id } });
      await prisma.skillGroup.deleteMany({ where: { id } });
    }
    for (const id of created.product) await prisma.consultProduct.deleteMany({ where: { id } });
    for (const id of created.wfDef) await prisma.workflowDefinition.deleteMany({ where: { id } });
    for (const id of created.consultSetting) await prisma.consultSetting.deleteMany({ where: { id } });

    // setup fixture
    await prisma.automationPolicy.deleteMany({ where: { clinicId: { in: [F.clinicF, F.clinicDispo] } } });
    await prisma.consultSetting.deleteMany({ where: { clinicId: { in: [F.clinicF, F.clinicDispo] } } });
    await prisma.knowledgeDoc.deleteMany({ where: { id: F.kdocF } });
    await prisma.followupRule.deleteMany({ where: { id: F.followupRule } });
    await prisma.routingRule.deleteMany({ where: { id: F.ruleTy } });
    await prisma.alert.deleteMany({ where: { id: F.alertF } });
    await prisma.suggestionCard.deleteMany({ where: { id: F.suggF } });
    await prisma.goldenCase.deleteMany({ where: { id: F.goldenF } });
    await prisma.goldenCase.deleteMany({ where: { id: F.goldenTy } });
    await prisma.message.deleteMany({ where: { id: F.msgPre } });
    await prisma.conversation.deleteMany({ where: { id: F.convPre } });
    await prisma.contact.deleteMany({ where: { waId: "8526300001" } });
    await prisma.workflowDefinition.deleteMany({ where: { id: F.publishDef } });
    await prisma.clinic.deleteMany({ where: { id: { in: [F.clinicF, F.clinicDispo] } } });
    // fixture 用戶（matrix PUT 改過 scope — 反正刪走，唔使還原）
    await prisma.staffClinic.deleteMany({ where: { staffId: { in: Object.values(F) } } });
    await prisma.staffUser.deleteMany({ where: { email: { in: TEST_EMAILS } } });
    await prisma.staffUser.deleteMany({ where: { id: { in: Object.values(F) } } });
    await prisma.pushSubscription.deleteMany({ where: { staffId: { in: [F.staffTy, F.adminAll] } } });

    // 還原 TY automation policy（automation PATCH 格寫咗 L2 — 真店行為要還原）
    // （TY.companyId 已喺 runMatrix 尾還原）
    const tyRow2 = await prisma.clinic.findUnique({ where: { code: "TY" }, select: { id: true } });
    if (tyRow2) {
      const pol = await prisma.automationPolicy.findUnique({ where: { clinicId_category: { clinicId: tyRow2.id, category: "BOOKING_REQUEST" } } });
      if (tyPolicyOriginal) {
        await prisma.automationPolicy.update({ where: { clinicId_category: { clinicId: tyRow2.id, category: "BOOKING_REQUEST" } }, data: { level: tyPolicyOriginal.level } });
      } else if (pol) {
        await prisma.automationPolicy.delete({ where: { id: pol.id } });
      }
    }
    // 還原 template
    if (templateOriginal) {
      await prisma.followupTemplate.update({
        where: { key: templateOriginal.key },
        data: { approved: templateOriginal.approved, approvedAt: templateOriginal.approvedAt, approvedBy: templateOriginal.approvedBy, text: templateOriginal.text, updatedAt: templateOriginal.updatedAt },
      });
    }
    // mock symlink
    if (mockSymlinkCreated) {
      try { if (fs.existsSync(MOCK_CLINICAL)) fs.rmSync(MOCK_CLINICAL); } catch { /* */ }
      try { fs.rmSync(MOCK_CLINICAL_SRC); } catch { /* */ }
    }
    // fixture 產生嘅 audit/alert（T638 斷言完先洗）
    await prisma.auditLog.deleteMany({ where: { staffId: { in: Object.values(F) } } });
    await prisma.alert.deleteMany({ where: { clinicCode: { in: ["T630F", "T630D", "T630X"] } } });
  } catch (e) {
    console.error("teardown 有錯（殘留風險 — 核對！）:", e);
  }
  const leftoverStaff = await prisma.staffUser.count({ where: { email: { in: TEST_EMAILS } } }).catch(() => -1);
  const leftoverClinic = await prisma.clinic.count({ where: { code: { in: ["T630F", "T630D", "T630X"] } } }).catch(() => -1);
  console.log(`teardown: leftover staff=${leftoverStaff} clinic=${leftoverClinic}（應該 0/0）`);
}

// ── MATRIX runner ───────────────────────────────────────────────────────────
async function runMatrix(fx: Fixtures) {
  console.log("\n═══ T630 MATRIX ═══");
  const discovered = discoverRoutes();
  const registered = new Set(Object.keys(MATRIX));
  const missing = [...discovered].filter((k) => !registered.has(k)).sort();
  const extra = [...registered].filter((k) => !discovered.has(k)).sort();
  assertTrue(`coverage: discovered ${discovered.size} METHOD/path 全部登記`, missing.length === 0, `missing: ${missing.join(", ")}`);
  assertTrue("coverage: MATRIX 無指向唔存在 route 嘅行", extra.length === 0, `extra: ${extra.join(", ")}`);
  if (missing.length > 0 || extra.length > 0) {
    console.log("coverage gate 紅 — 唔繼續跑格（先補登記）");
    return false;
  }

  for (const key of Object.keys(MATRIX)) {
    const row = MATRIX[key];
    const req = row.fixture(fx) as { url: string; method: string; body?: string };
    console.log(`\n── ${key}`);
    for (const [id, want] of Object.entries(row.expect) as [Id, number][]) {
      const fpBefore = isWrite(req.method) ? await dbFingerprint() : null;
      const r = await api(id, req.method, req.url, req.body !== undefined ? JSON.parse(req.body) : undefined);
      assertEq(`${key} @ ${id}`, r.status, want);
      if (fpBefore && r.status >= 400) {
        const fpAfter = await dbFingerprint();
        assertTrue(`${key} @ ${id} 4xx DB 冇變`, fpBefore === fpAfter, "fingerprint 漂移");
      }
      // 捕捉 201/200 產物 id（cleanup 用）
      const j = r.json;
      const pid = j?.id;
      if (r.status < 300 && pid) {
        if (key === "POST /api/admin/staff") created.staff.push(pid);
        else if (key === "POST /api/admin/clinics") created.clinic.push(pid);
        else if (key === "POST /api/admin/knowledge") created.kdoc.push(pid);
        else if (key === "POST /api/admin/routing-rules") created.routing.push(pid);
        else if (key === "POST /api/admin/skill-groups") created.skill.push(pid);
        else if (key === "POST /api/admin/consult-products") created.product.push(pid);
      }
      if (r.status < 300 && key === "PUT /api/admin/workflows/[key]" && pid) created.wfDef.push(pid);
    }
  }

  // matrix 後即刻還原 TY（T631 要斷「改唔到 TY 設定」）
  await prisma.clinic.updateMany({ where: { code: "TY" }, data: { companyId: clinicTyOriginal.companyId } });
  await prisma.alert.deleteMany({ where: { clinicId: fx.clinicTY.id, type: "clinic_critical_change" } });
  await prisma.auditLog.deleteMany({ where: { action: "CLINIC_CRITICAL_CHANGE", entity: "Clinic", entityId: fx.clinicTY.id } });
  return true;
}

// ── T631（ADMIN_COMPANY_B 行為）─────────────────────────────────────────────
async function t631(fx: Fixtures) {
  console.log("\n═══ T631 — ADMIN_COMPANY_B ═══");
  // 1. 只見 YMT/TW/MF（+ 自己公司嘅 2 間 fixture 診所）
  const clinics = await api("ADMIN_COMPANY_B", "GET", "/api/admin/clinics");
  assertEq("T631 clinics GET status", clinics.status, 200);
  const codes = (clinics.json ?? []).map((c: any) => c.code).sort();
  // T630D 已喺 matrix DELETE row 被 ALL 刪 — 剩 T630F + T630X（matrix POST row 由 ALL 建，公司 B）
  const want = ["MF", "T630F", "T630X", "TW", "YMT"].sort();
  assertTrue("T631 只見 YMT/TW/MF（+fixture T630F）", JSON.stringify(codes) === JSON.stringify(want), `got ${JSON.stringify(codes)}`);

  // 2. staff 列表：只有 scope 內 STAFF（唔見 STAFF_TY；ADMIN/SUPERVISOR 唔回）
  const staff = await api("ADMIN_COMPANY_B", "GET", "/api/admin/staff");
  assertEq("T631 staff GET status", staff.status, 200);
  const emails = (staff.json ?? []).map((u: any) => u.email);
  assertTrue("T631 staff 唔見 STAFF_TY", !emails.includes("t630.staff.ty@wa-clinic.local"), `got ${JSON.stringify(emails)}`);
  assertTrue("T631 staff 見 STAFF_YMT", emails.includes("t630.staff.ymt@wa-clinic.local"), `got ${JSON.stringify(emails)}`);
  assertTrue("T631 staff 唔見 ADMIN/SUPERVISOR", !(staff.json ?? []).some((u: any) => u.role !== "STAFF"), `roles: ${(staff.json ?? []).map((u: any) => u.role).join(",")}`);

  // 3. 改唔到自己（spec 例：scopeType=ALL）— 目標角色 = ADMIN（非 STAFF）→ 403
  const self = await api("ADMIN_COMPANY_B", "PUT", `/api/admin/staff/${F.adminCompB}`, { scopeType: "ALL" });
  assertEq("T631 改自己範圍 = 403", self.status, 403);

  // 4. 改唔到 TY 設定（ clinic / settings / automation / knowledge / workflow publish 全局）
  const patchTy = await api("ADMIN_COMPANY_B", "PATCH", `/api/admin/clinics/${fx.clinicTY.id}`, { name: "TY hacked" });
  assertEq("T631 PATCH TY clinic = 403", patchTy.status, 403);
  const csTy = await api("ADMIN_COMPANY_B", "PUT", "/api/admin/consult-settings", { clinicId: fx.clinicTY.id, key: "rules", value: RULES_VALUE });
  assertEq("T631 TY consult-settings = 403", csTy.status, 403);
  const csGlobal = await api("ADMIN_COMPANY_B", "PUT", "/api/admin/consult-settings", { clinicId: null, key: "rules", value: RULES_VALUE });
  assertEq("T631 全局 consult-settings = 403", csGlobal.status, 403);
  const autoTy = await api("ADMIN_COMPANY_B", "PATCH", "/api/admin/automation", { clinicId: fx.clinicTY.id, category: "BOOKING_REQUEST", level: "L2" });
  assertEq("T631 TY automation = 403", autoTy.status, 403);
  // kdocF 已喺 matrix DELETE row 被 ALL 刪 — 另建 transient TY doc 斷 403
  await prisma.knowledgeDoc.create({ data: { id: "t630kdocg0000000000000002", clinicId: fx.clinicTY.id, kind: "FAQ", title: "T631 TY doc", keywords: ["t631"], body: "fixture" } });
  // 完整有效 body（PUT = 整條更新；validation 先於 scope — 唔有效 body 會 400 截走 403 斷言）
  const knTy = await api("ADMIN_COMPANY_B", "PUT", "/api/admin/knowledge/t630kdocg0000000000000002", { clinicId: fx.clinicTY.id, kind: "FAQ", title: "hacked", keywords: ["t631"], body: "hacked", disclaimer: null, priceMin: null, priceMax: null });
  assertEq("T631 TY knowledge PUT = 403", knTy.status, 403);
  await prisma.knowledgeDoc.deleteMany({ where: { id: "t630kdocg0000000000000002" } });
  // workflow publish 全局 draft（transient — 斷完即刪）
  await prisma.workflowDefinition.create({
    data: { id: F.publishDef, clinicId: null, key: "triage", version: 99, status: "DRAFT", graph: {}, params: {} },
  });
  const pubGlobal = await api("ADMIN_COMPANY_B", "POST", "/api/admin/workflows/triage/publish", { defId: F.publishDef });
  assertEq("T631 publish 全局 workflow = 403", pubGlobal.status, 403);
  await prisma.workflowDefinition.deleteMany({ where: { id: F.publishDef } });

  // 5. 自己店可以改（正面对照）
  const csOwn = await api("ADMIN_COMPANY_B", "PUT", "/api/admin/consult-settings", { clinicId: fx.clinicF.id, key: "rules", value: RULES_VALUE });
  assertEq("T631 自己店 consult-settings = 200", csOwn.status, 200);

  // 6. 建自己公司 STAFF = 201（POST 正面对照）
  const newStaff = await api("ADMIN_COMPANY_B", "POST", "/api/admin/staff", {
    email: "t630.newcb@wa-clinic.local", name: "T630 New CB", role: "STAFF",
    scopeType: "CLINICS", clinicIds: [fx.clinicYMT.id], password: PASS,
  });
  assertEq("T631 CB 建 YMT STAFF = 201", newStaff.status, 201);
  if (newStaff.json?.id) {
    await prisma.staffClinic.deleteMany({ where: { staffId: newStaff.json.id } });
    await prisma.staffUser.deleteMany({ where: { id: newStaff.json.id } });
  }

  // 7. quotes（spec 例子註釋）：STAFF_TY 只見 TY
  const q = await api("STAFF_TY", "GET", "/api/admin/quotes");
  assertEq("T631 quotes STAFF_TY status", q.status, 200);
  const qc = new Set(((q.json?.quotes ?? []) as any[]).map((x: any) => x.clinicCode).filter(Boolean));
  assertTrue("T631 quotes STAFF_TY 只見 TY", qc.size === 0 || [...qc].every((c) => c === "TY"), `got ${[...qc].join(",")}`);

  // 8. ai-sandbox/run scope（有效 body → scope 403 喺執行前 — 零 side effect）
  const sbx = await api("ADMIN_COMPANY_B", "POST", "/api/admin/ai-sandbox/run", { clinicId: fx.clinicTY.id, message: "t631 sandbox" });
  assertEq("T631 CB ai-sandbox/run（TY 店）= 403", sbx.status, 403);
}

// ── T638（術語字典 6 斷言）──────────────────────────────────────────────────
async function t638() {
  console.log("\n═══ T638 — 臨床術語字典 ═══");
  const terms = [{ shorthand: "T630X", nameCn: "矩陣測試術語", active: true }];
  const put = (id: Id) => api(id, "PUT", "/api/admin/clinical-terms", { terms });

  assertEq("T638 STAFF PUT = 403", (await put("STAFF_TY")).status, 403);
  assertEq("T638 COMPANY ADMIN PUT = 403", (await put("ADMIN_COMPANY_B")).status, 403);
  assertEq("T638 SUPERVISOR PUT = 403", (await put("SUPERVISOR")).status, 403);

  const putAll = await put("ADMIN_ALL");
  assertEq("T638 ALL ADMIN PUT = 200", putAll.status, 200);
  const al = await prisma.auditLog.findFirst({
    where: { action: "CLINICAL_TERMS_UPDATE", staffId: F.adminAll },
    orderBy: { createdAt: "desc" },
  });
  assertTrue("T638 AuditLog CLINICAL_TERMS_UPDATE 有 row", al !== null, `row=${al ? JSON.stringify(al.meta) : "null"}`);

  const get = await api("STAFF_TY", "GET", "/api/admin/clinical-terms");
  assertEq("T638 STAFF GET = 200", get.status, 200);
  assertTrue("T638 GET body v=1 + terms[]", get.json?.v === 1 && Array.isArray(get.json?.terms));

  // 頁面 SSR（data-e2e 標記）— ★ cookie map 以角色 Id 做 key（cookie["STAFF_TY"]，唔係 cuid）
  // - SUPERVISOR：layout 放行人（S3 起）+ canEdit=false → 唯讀提示 ✓ 無新增掣 ✓（S3-4 D-5 目標態）
  // - STAFF_TY：(admin) layout base fail-closed → 403（非唯讀頁 — 術語「讀」係經 API，唔係管理頁）
  const supPage = await fetch(BASE + "/admin/clinical-terms", { headers: { cookie: cookie["SUPERVISOR"] }, signal: AbortSignal.timeout(120_000) });
  const supHtml = await supPage.text();
  assertEq("T638 SUPERVISOR 頁面 status", supPage.status, 200);
  assertTrue("T638 SUPERVISOR 頁有唯讀提示（ct-readonly-notice）", supHtml.includes('data-e2e="ct-readonly-notice"'));
  assertTrue("T638 SUPERVISOR 頁冇新增掣（ct-add）", !supHtml.includes('data-e2e="ct-add"'));
  const staffPage = await fetch(BASE + "/admin/clinical-terms", { headers: { cookie: cookie["STAFF_TY"] }, signal: AbortSignal.timeout(120_000) });
  assertEq("T638 STAFF 頁面 = 403（layout fail-closed）", staffPage.status, 403);
}

// ── T639（flag-off 守衛 — 另個 phase 跑）────────────────────────────────────
async function apiWithCookie(c: string, method: string, urlPath: string, body?: unknown) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { cookie: c, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
}

async function t639() {
  console.log("\n═══ T639 — ALLOW_SCOPED_ADMIN 未設 ═══");
  const pw = await argon2.hash(PASS);
  await prisma.staffUser.deleteMany({ where: { email: { in: ["t639.caller@wa-clinic.local", "t639.compadmin@wa-clinic.local", "t639.compstaff@wa-clinic.local"] } } });
  const caller = await prisma.staffUser.upsert({
    where: { id: "t639callera0000000000000001" },
    update: { active: true, passwordHash: pw },
    create: { id: "t639callera0000000000000001", email: "t639.caller@wa-clinic.local", name: "T639 Caller", role: "ADMIN", scopeType: "ALL", active: true, passwordHash: pw },
  });
  const companyB = await prisma.company.findFirst({ where: { code: "B" }, select: { id: true } });
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.63.9.9" },
    body: JSON.stringify({ email: "t639.caller@wa-clinic.local", password: PASS }),
  });
  if (res.status !== 200) throw new Error(`t639 login fail ${res.status}`);
  const cCookie = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=[^;]+/)?.[0];

  // 1. 建 COMPANY scope ADMIN → 400 SCOPED_ADMIN_DISABLED
  const r1 = await apiWithCookie(cCookie!, "POST", "/api/admin/staff", {
    email: "t639.compadmin@wa-clinic.local", name: "T639 CompAdmin", role: "ADMIN",
    scopeType: "COMPANY", scopeCompanyId: companyB!.id, password: PASS,
  });
  assertEq("T639 建 COMPANY ADMIN = 400", r1.status, 400);
  assertTrue("T639 error = SCOPED_ADMIN_DISABLED", r1.json?.error === "SCOPED_ADMIN_DISABLED", `got ${JSON.stringify(r1.json)}`);

  // 2. 建 COMPANY scope STAFF → 201（工單口徑「200」= 2xx；route 實際 201）
  const r2 = await apiWithCookie(cCookie!, "POST", "/api/admin/staff", {
    email: "t639.compstaff@wa-clinic.local", name: "T639 CompStaff", role: "STAFF",
    scopeType: "COMPANY", scopeCompanyId: companyB!.id, password: PASS,
  });
  assertTrue("T639 建 COMPANY STAFF = 201", r2.status === 201, `got ${r2.status} ${JSON.stringify(r2.json)}`);

  // cleanup
  await prisma.staffUser.deleteMany({ where: { id: { in: [caller.id, r2.json?.id].filter(Boolean) } } });
}

// ── main（CJS — tsx 無 type:module → 唔可以用 top-level await）────────────────
async function main() {
  const phase = (process.argv.find((a) => a.startsWith("--phase=")) ?? "").split("=")[1] ?? "t630";

  if (phase === "t639") {
    try {
      await t639();
    } finally {
      await prisma.$disconnect();
    }
  } else {
    let fx: Fixtures;
    try {
      fx = await setup();
    } catch (e) {
      console.error("SETUP FAIL:", e);
      await teardown();
      await prisma.$disconnect();
      process.exit(1);
    }
    try {
      await probeCookies();
      const ok = await runMatrix(fx);
      if (ok) {
        await t631(fx);
        await t638();
      }
    } finally {
      await teardown();
      await prisma.$disconnect();
    }
  }

  console.log(`\n═══ RESULT: pass=${pass} fail=${fail} ═══`);
  if (failures.length) {
    console.log("失敗清單:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
