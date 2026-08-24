/**
 * unit-workflow-store — Phase D（cwi-ai-20260825-t4）DB-backed unit tests（.env DB — 15432）
 *
 * 範圍（MD D6 五組中 DB 相關四組）：
 *   G1 三級 fallback：clinic ACTIVE → global ACTIVE → code defaults（含 env 底）
 *   G2 壞 row merge：zod safeParse 唔過 → 逐欄位 merge defaults
 *   G3 publish 唯一 ACTIVE + 冪等重複 publish 409 + DB unique 底
 *   G4 revert = re-publish as v(n+1)（歷史唔改寫）；唔存在版本 404
 *   G5 zod 拒絕（saveDraft 400 + field-level issues）
 *
 * 隔離：全部 row createdBy = `wfunit-<epoch>`（自帶 scope marker）；clinicId = `wfunit-clinic-<epoch>`
 * （無 FK 約束，任意字串）；finally 清晒（含 global row — createdBy 同樣 marker）。
 *
 * 用法（repo root）：pnpm test:unit-workflow-store
 * 退出碼：0 = 全過；1 = 有 fail
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env 冇就靠 process env */
}
// 清走 env 救急底 — 斷言 pure code defaults（唔受 .env 影響）
for (const k of ["AI_HUMAN_COOLDOWN_MS", "REMINDER_MIN_HOURS", "REMINDER_MAX_HOURS", "TEMPLATE_REMINDER_NAME", "TEMPLATE_REMINDER_LANG"]) {
  delete process.env[k];
}

import { prisma } from "../src/lib/prisma";
import {
  getParams,
  saveDraft,
  publish,
  revert,
  listVersions,
  getActiveInfo,
  bustParamsCache,
  WorkflowError,
} from "../src/lib/workflow/store";
import { PARAMS_DEFAULTS } from "../src/lib/workflow/definitions";

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const EPOCH = Date.now();
const STAFF = `wfunit-${EPOCH}`;
const CLINIC = `wfunit-clinic-${EPOCH}`;
const CLINIC_B = `wfunit-clinic-b-${EPOCH}`;

void (async () => {

try {
  // 冪等 pre-cleanup（上次 crash 殘留）
  await prisma.workflowDefinition.deleteMany({ where: { createdBy: STAFF } });

  const triageDefaults = PARAMS_DEFAULTS.triage;
  const sessionDefaults = PARAMS_DEFAULTS["booking-session"];

  // ── G1 三級 fallback ─────────────────────────────────────────────
  console.log("G1 三級 fallback（clinic → global → defaults）");
  {
    // (a) 零 row → code defaults
    const p0 = await getParams("triage", CLINIC);
    check("G1-1 零 row → defaults（30min / 0.6）", p0.humanCooldownMs === 30 * 60_000 && p0.confidenceFloor === 0.6, JSON.stringify(p0));

    // (b) global ACTIVE → 全部 clinic 視角都跟
    const g1 = await saveDraft("triage", null, { ...triageDefaults, confidenceFloor: 0.9 }, STAFF);
    await publish(g1.id, STAFF);
    bustParamsCache();
    const gGlob = await getParams("triage", null);
    const gClinic = await getParams("triage", CLINIC);
    check("G1-2 global row 生效（confidenceFloor 0.9）", gGlob.confidenceFloor === 0.9, JSON.stringify(gGlob));
    check("G1-3 clinic 視角落到 global（0.9）", gClinic.confidenceFloor === 0.9);
    check("G1-4 未改欄位照 defaults（30min）", gClinic.humanCooldownMs === 30 * 60_000);

    // (c) clinic ACTIVE → 本店贏過 global；其他店照 global
    const c1 = await saveDraft("triage", CLINIC, { ...triageDefaults, humanCooldownMs: 1234 }, STAFF);
    await publish(c1.id, STAFF);
    bustParamsCache();
    const cMe = await getParams("triage", CLINIC);
    const cOther = await getParams("triage", CLINIC_B);
    check("G1-5 clinic row 贏過 global（1234ms）", cMe.humanCooldownMs === 1234, JSON.stringify(cMe));
    check(
      "G1-6 clinic row 整體替換（confidenceFloor = row 值 0.6，唔逐欄位 merge global）",
      cMe.confidenceFloor === 0.6,
      String(cMe.confidenceFloor)
    );
    check("G1-7 其他店唔受 clinic row 影響（0.9 / 30min）", cOther.confidenceFloor === 0.9 && cOther.humanCooldownMs === 30 * 60_000);

    // (d) getActiveInfo source 標記
    const infoMe = await getActiveInfo("triage", CLINIC);
    const infoOther = await getActiveInfo("triage", CLINIC_B);
    check("G1-8 source=clinic（本店）", infoMe.source === "clinic" && infoMe.version === 1, JSON.stringify({ s: infoMe.source, v: infoMe.version }));
    check("G1-9 source=global（其他店）", infoOther.source === "global");

    // (e) cache：改 DB 直改 row（繞 store）→ 唔 bust 就返舊值；bust 後返新值
    const activeRow = await prisma.workflowDefinition.findFirst({ where: { key: "triage", clinicId: CLINIC, status: "ACTIVE" } });
    if (activeRow) {
      await prisma.workflowDefinition.update({ where: { id: activeRow.id }, data: { params: { ...triageDefaults, humanCooldownMs: 9999 } } });
      const cached = await getParams("triage", CLINIC);
      check("G1-10 TTL cache 生效（未 bust 返舊值 1234）", cached.humanCooldownMs === 1234, String(cached.humanCooldownMs));
      bustParamsCache();
      const fresh = await getParams("triage", CLINIC);
      check("G1-11 bust 後返新值（9999）", fresh.humanCooldownMs === 9999, String(fresh.humanCooldownMs));
      // 還原
      await prisma.workflowDefinition.update({ where: { id: activeRow.id }, data: { params: { ...triageDefaults, humanCooldownMs: 1234 } } });
      bustParamsCache();
    } else {
      check("G1-10/11 cache 測試（找不到 ACTIVE row — 前設失敗）", false);
    }
  }

  // ── G2 壞 row merge ──────────────────────────────────────────────
  console.log("G2 壞 row 處理（partial → merge defaults；全壞 → full defaults）");
  {
    const activeRow = await prisma.workflowDefinition.findFirst({ where: { key: "triage", clinicId: null, status: "ACTIVE" } });
    if (!activeRow) {
      check("G2-0 global ACTIVE row 存在（前設）", false);
    } else {
      // (A) partial row（缺欄位 — legacy 形態）→ merge defaults 補齊後 parse 成功
      await prisma.workflowDefinition.update({ where: { id: activeRow.id }, data: { params: { confidenceFloor: 0.11 } } });
      bustParamsCache();
      const pA = await getParams("triage", null);
      check("G2-1 partial row：有效欄位保留（confidenceFloor 0.11）", pA.confidenceFloor === 0.11, JSON.stringify(pA));
      check("G2-2 partial row：缺欄位補 defaults（30min / 原句）", pA.humanCooldownMs === 30 * 60_000 && pA.autoThanksReply === triageDefaults.autoThanksReply);
      // (B) 全壞 row（壞型別 + 超長）→ merge 再 parse 仍唔過 → 整套 code defaults
      await prisma.workflowDefinition.update({
        where: { id: activeRow.id },
        data: { params: { confidenceFloor: 0.11, humanCooldownMs: "not-a-number", autoThanksReply: "x".repeat(200) } },
      });
      bustParamsCache();
      const pB = await getParams("triage", null);
      check("G2-3 全壞 row → 整套 code defaults（0.6 / 30min / 原句）", pB.confidenceFloor === 0.6 && pB.humanCooldownMs === 30 * 60_000 && pB.autoThanksReply === triageDefaults.autoThanksReply, JSON.stringify(pB));
      // 還原
      await prisma.workflowDefinition.update({ where: { id: activeRow.id }, data: { params: { ...triageDefaults, confidenceFloor: 0.9 } } });
      bustParamsCache();
    }
  }

  // ── G3 publish 唯一 ACTIVE + 冪等 + DB unique 底 ─────────────────
  console.log("G3 publish 唯一 ACTIVE");
  {
    const s1 = await saveDraft("booking-session", CLINIC, { ...sessionDefaults, maxTurns: 10 }, STAFF);
    const s2 = await saveDraft("booking-session", CLINIC, { ...sessionDefaults, maxTurns: 20 }, STAFF);
    check("G3-1 兩草稿 v1/v2", s1.version === 1 && s2.version === 2, JSON.stringify({ a: s1.version, b: s2.version }));
    await publish(s1.id, STAFF);
    let actives = await prisma.workflowDefinition.findMany({ where: { key: "booking-session", clinicId: CLINIC, status: "ACTIVE" } });
    check("G3-2 publish v1 → 唯一 ACTIVE", actives.length === 1 && actives[0].version === 1);
    await publish(s2.id, STAFF);
    actives = await prisma.workflowDefinition.findMany({ where: { key: "booking-session", clinicId: CLINIC, status: "ACTIVE" } });
    const v1now = await prisma.workflowDefinition.findUnique({ where: { id: s1.id } });
    check("G3-3 publish v2 → v2 ACTIVE / v1 ARCHIVED（歷史保留）", actives.length === 1 && actives[0].version === 2 && v1now?.status === "ARCHIVED");
    // 冪等：重複 publish 同一行 → 409
    let dupStatus = 0;
    try {
      await publish(s2.id, STAFF);
    } catch (err) {
      if (err instanceof WorkflowError) dupStatus = err.status;
    }
    check("G3-4 重複 publish → WorkflowError 409", dupStatus === 409, `status=${dupStatus}`);
    // DB unique 底（clinic scope）：手掣 create 重複 (key, clinicId, version) → P2002
    let dbCode = "";
    try {
      await prisma.workflowDefinition.create({
        data: {
          key: "booking-session",
          clinicId: CLINIC,
          version: 2,
          status: "DRAFT",
          graph: { nodes: [], edges: [] },
          params: { ...sessionDefaults },
          createdBy: STAFF,
        },
      });
    } catch (err) {
      dbCode = (err as { code?: string }).code ?? "";
    }
    check("G3-5 DB unique 底（重複 version → P2002）", dbCode === "P2002", `code=${dbCode}`);
    await prisma.workflowDefinition.deleteMany({ where: { clinicId: CLINIC, key: "booking-session", version: 2, status: "DRAFT", createdBy: STAFF } }).catch(() => null);
    // 全局 unique 陷阱文檔化：global row（clinicId NULL）Postgres NULL-distinct → 無 unique 保護（已知偏離，saveDraft tx 序列化）
    const gDup = await saveDraft("booking-session", null, { ...sessionDefaults, maxTurns: 11 }, STAFF);
    check("G3-6 global scope 亦分配 version（tx max+1）", gDup.version >= 1, `v=${gDup.version}`);
  }

  // ── G4 revert = re-publish as v(n+1) ─────────────────────────────
  console.log("G4 revert");
  {
    const { id, newVersion } = await revert("booking-session", CLINIC, 1, STAFF);
    check("G4-1 revert v1 → newVersion = max(2)+1 = 3", newVersion === 3 && id.length > 0, `newVersion=${newVersion}`);
    const v3 = await prisma.workflowDefinition.findUnique({ where: { id } });
    const v1 = await prisma.workflowDefinition.findFirst({ where: { key: "booking-session", clinicId: CLINIC, version: 1 } });
    check("G4-2 v3 = ACTIVE 且 params 同 v1（maxTurns 10）", v3?.status === "ACTIVE" && (v3.params as { maxTurns: number }).maxTurns === 10);
    check("G4-3 params byte-for-byte 同 v1", JSON.stringify(v3?.params) === JSON.stringify(v1?.params));
    const actives = await prisma.workflowDefinition.findMany({ where: { key: "booking-session", clinicId: CLINIC, status: "ACTIVE" } });
    check("G4-4 revert 後唯一 ACTIVE（v3）", actives.length === 1 && actives[0].version === 3);
    const p = await getParams("booking-session", CLINIC);
    check("G4-5 getParams 即刻生效（maxTurns 10，零 bust — publish 內已 bust）", p.maxTurns === 10, String(p.maxTurns));
    // 唔存在版本 → 404
    let nfStatus = 0;
    try {
      await revert("booking-session", CLINIC, 99, STAFF);
    } catch (err) {
      if (err instanceof WorkflowError) nfStatus = err.status;
    }
    check("G4-6 revert 唔存在版本 → 404", nfStatus === 404, `status=${nfStatus}`);
    // listVersions DESC + 欄位齊
    const vers = await listVersions("booking-session", CLINIC);
    check("G4-7 listVersions 3 行 DESC（3,2,1）", vers.length === 3 && vers[0].version === 3 && vers[2].version === 1, JSON.stringify(vers.map((v) => v.version)));
  }

  // ── G5 zod 拒絕（saveDraft 400 + field-level issues）────────────
  console.log("G5 saveDraft zod 拒絕");
  {
    let err: unknown = null;
    try {
      await saveDraft("triage", null, { confidenceFloor: 0.5 }, STAFF); // 少欄位
    } catch (e) {
      err = e;
    }
    check("G5-1 少欄位 → WorkflowError 400", err instanceof WorkflowError && err.status === 400, String(err));
    const issues = (err as WorkflowError | null)?.issues ?? [];
    check("G5-2 field-level issues 有內容", issues.length >= 1 && typeof issues[0].path === "string", JSON.stringify(issues));
    let err2: unknown = null;
    try {
      await saveDraft("reminder", null, { minHours: 30, maxHours: 10, templateName: "x", templateLang: "zh" }, STAFF);
    } catch (e) {
      err2 = e;
    }
    check("G5-3 窗口反轉 → 400", err2 instanceof WorkflowError && (err2 as WorkflowError).status === 400, String(err2));
  }
} finally {
  // 清晒（包括 global row — createdBy 同樣 marker；唔會郁到其他 run 嘅 row）
  const del = await prisma.workflowDefinition.deleteMany({ where: { createdBy: STAFF } }).catch(() => null);
  console.log(`cleanup: deleted ${del?.count ?? "?"} rows (marker=${STAFF})`);
}

console.log(`\nunit-workflow-store: ${passes} pass, ${failures} fail`);
process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
