/**
 * unit-workflow-definitions — Phase D（cwi-ai-20260825-t4）pure unit tests（零 DB / 零網絡）
 *
 * 範圍：
 *   G1 zod schema 拒絕（bad shape / 超長文案 / 窗口反轉 / 負數）
 *   G2 fillVars：佔位符 deterministic 替換；未知佔位符原樣保留
 *   G3 buildGraph：3 key 都有 nodes/edges；edge 端點存在；triage 含第九閘（confidenceFloor 進 subtitle）
 *   G4 defaults 鐵律：= 現有 code 硬編碼原句（防漂移）
 *   G5 SCHEMA_HINTS 覆蓋所有 schema 欄位（admin 表單驅動完整性）
 *
 * 用法（repo root）：pnpm test:unit-workflow-definitions
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { z } from "zod";
import {
  PARAMS_DEFAULTS,
  PARAMS_SCHEMAS,
  SCHEMA_HINTS,
  WORKFLOW_KEYS,
  fillVars,
  buildGraph,
  type SessionParamsType,
  type TriageParamsType,
  type ReminderParamsType,
} from "../src/lib/workflow/definitions";

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

// ── G1 zod 拒絕 ───────────────────────────────────────────────────────
console.log("G1 zod schema 拒絕");
{
  const t = PARAMS_SCHEMAS.triage as z.ZodType<TriageParamsType>;
  check("G1-1 負數 cooldown 拒絕", !t.safeParse({ ...PARAMS_DEFAULTS.triage, humanCooldownMs: -1 }).success);
  check(
    "G1-2 超長 autoThanksReply（>120）拒絕",
    !t.safeParse({ ...PARAMS_DEFAULTS.triage, autoThanksReply: "x".repeat(121) }).success
  );
  check("G1-3 confidenceFloor > 1 拒絕", !t.safeParse({ ...PARAMS_DEFAULTS.triage, confidenceFloor: 1.5 }).success);
  check("G1-4 少欄位拒絕", !t.safeParse({ confidenceFloor: 0.6 }).success);

  const s = PARAMS_SCHEMAS["booking-session"] as z.ZodType<SessionParamsType>;
  check(
    "G1-5 超長 confirmText（>160）拒絕",
    !s.safeParse({ ...PARAMS_DEFAULTS["booking-session"], confirmText: "x".repeat(161) }).success
  );
  check("G1-6 candidateCount 超上限（>8）拒絕", !s.safeParse({ ...PARAMS_DEFAULTS["booking-session"], candidateCount: 9 }).success);

  const r = PARAMS_SCHEMAS.reminder as z.ZodType<ReminderParamsType>;
  check(
    "G1-7 窗口反轉（max<min）拒絕",
    !r.safeParse({ ...PARAMS_DEFAULTS.reminder, minHours: 24, maxHours: 12 }).success
  );
  check("G1-8 全部 defaults 各 key parse 通過", WORKFLOW_KEYS.every((k) => PARAMS_SCHEMAS[k].safeParse(PARAMS_DEFAULTS[k]).success));
}

// ── G2 fillVars ───────────────────────────────────────────────────────
console.log("G2 fillVars");
{
  check(
    "G2-1 已知佔位符替換",
    fillVars("同你確認：{date} {time} {provider}", { date: "2026-09-01", time: "15:00", provider: "陳醫生" }) ===
      "同你確認：2026-09-01 15:00 陳醫生"
  );
  check(
    "G2-2 未知佔位符原樣保留",
    fillVars("{date} 同 {unknownVar}", { date: "2026-09-01" }) === "2026-09-01 同 {unknownVar}"
  );
  check("G2-3 重複佔位符全部替換", fillVars("{a}{a}{a}", { a: "7" }) === "777");
  check("G2-4 無佔位符原樣返回", fillVars("冇佔位符嘅句子", {}) === "冇佔位符嘅句子");
  check("G2-5 空 vars 全部保留", fillVars("{a} {b}", {}) === "{a} {b}");
}

// ── G3 buildGraph ─────────────────────────────────────────────────────
console.log("G3 buildGraph");
{
  for (const key of WORKFLOW_KEYS) {
    const g = buildGraph(key, PARAMS_DEFAULTS[key]);
    const ids = new Set(g.nodes.map((n) => n.id));
    check(`G3-${key} nodes≥3 / edges≥2`, g.nodes.length >= 3 && g.edges.length >= 2, JSON.stringify({ n: g.nodes.length, e: g.edges.length }));
    check(
      `G3-${key} edge 端點全部存在`,
      g.edges.every((e) => ids.has(e.from) && ids.has(e.to))
    );
  }
  const tg = buildGraph("triage", { ...PARAMS_DEFAULTS.triage, confidenceFloor: 0.42 });
  const gate9 = tg.nodes.find((n) => n.id.includes("confidence") || n.subtitle?.includes("0.42"));
  check("G3-triage 第九閘節點存在（confidenceFloor 進圖）", Boolean(gate9), JSON.stringify(tg.nodes.map((n) => n.id)));
}

// ── G4 defaults = 現有 code 硬編碼原句（防漂移）────────────────────────
console.log("G4 defaults 鐵律");
{
  check("G4-1 triage cooldown = 30min", PARAMS_DEFAULTS.triage.humanCooldownMs === 30 * 60_000);
  check("G4-2 triage confidenceFloor = 0.6", PARAMS_DEFAULTS.triage.confidenceFloor === 0.6);
  // session 原句（Phase C 落地版 — 同 session-engine 舊硬編碼 byte-for-byte）
  check(
    "G4-3 confirmText 原句",
    PARAMS_DEFAULTS["booking-session"].confirmText === "同你確認一次：{date} {time} {provider}，啱唔啱？"
  );
  check(
    "G4-4 candidateHeader 原句",
    PARAMS_DEFAULTS["booking-session"].candidateHeader === "而家有以下時段："
  );
  check("G4-5 maxTurns = 12", PARAMS_DEFAULTS["booking-session"].maxTurns === 12);
  check("G4-6 candidateCount = 5", PARAMS_DEFAULTS["booking-session"].candidateCount === 5);
  // reminder 原句（reminder.ts 舊 env 底）
  check("G4-7 reminder 窗口 = 23–25h", PARAMS_DEFAULTS.reminder.minHours === 23 && PARAMS_DEFAULTS.reminder.maxHours === 25);
  check(
    "G4-8 reminder template 原句",
    PARAMS_DEFAULTS.reminder.templateName === "appt_reminder_zh" && PARAMS_DEFAULTS.reminder.templateLang === "zh_HK"
  );
}

// ── G5 SCHEMA_HINTS 覆蓋 ──────────────────────────────────────────────
console.log("G5 SCHEMA_HINTS 完整性");
{
  for (const key of WORKFLOW_KEYS) {
    const schemaFields = PARAMS_SCHEMAS[key].safeParse(PARAMS_DEFAULTS[key]).success
      ? Object.keys(PARAMS_DEFAULTS[key])
      : [];
    const hintFields = SCHEMA_HINTS[key].map((h) => h.name);
    check(
      `G5-${key} hints 同 defaults 欄位一致`,
      schemaFields.length > 0 && hintFields.length === schemaFields.length && schemaFields.every((f) => hintFields.includes(f))
    );
  }
}

console.log(`\nunit-workflow-definitions: ${passes} pass, ${failures} fail`);
if (failures > 0) process.exit(1);
