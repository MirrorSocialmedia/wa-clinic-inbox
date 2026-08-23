/**
 * pii-scan — PII CI 守門（MD 任務 D / Phase 3 驗收「DB 全表掃描」）
 *
 * 三層掃描：
 * 1. SCHEMA：workforce cache 側表（AvailabilitySlot/WorkforceSyncState/BookingRequest/FlowSession/
 *    Provider/ProviderClinic）唔可以有 clinicPatient/visitReasons/diagnosis 類欄位
 * 2. CONTRACT-STRIP（2026-08-23 workforce 切換 — 舊 Apricot mock bait 層換位）：
 *    raw availability response 故意插 PII 欄（medicalHistory/clinicPatient/visitReasons/diagnosis）
 *    → 經 client 嘅 zod 契約 parse → 斷言 strip 後 output 零 PII key/值
 *    （防線 = 來源換咗但 PII 白名單不變；此層零 DB 可跑）
 * 3. DATA：抽呢幾張表嘅真實 DB 數據（JSON dump）+ AuditLog.meta grep
 *    — 含 ★ 負面斷言：AvailabilitySlot（L2 cache）序列化後零病人欄位（mock bait 經 L2 落庫後必須 0 hit）
 * 4. LOG：/tmp/e2e-*.log grep 同樣 marker（log 只准 metadata 鐵律）
 * 5. SUMMARY（安全審計 M-5）：抽 ≤50 條最新 Conversation.aiSummary，對照該 conversation
 *    嘅 contact.profileName（完整 + ≥2 字連續子串）同 waId 後 8 位 — 子串 hit = violation
 *    （H-3 deterministic scrub 生效驗證；E2E bait：mock summary 含 E2E-BAIT-SUM-7f3a，
 *    同名 contact 落庫後必須 0 hit）
 *
 * 用法（repo root）：pnpm pii-scan
 * 退出碼：0 = 乾淨；1 = 有 violation（E2E 最後一步跑）
 *
 * ★ marker 定義喺 ./pii-markers.ts（T33 flaky 修復：bare substring → word boundary / 精確格式）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchPiiMarkers, PII_FIELD_NAMES_SCHEMA } from "./pii-markers";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { PrismaClient } from "@prisma/client";
import { AvailabilityResponse } from "../src/lib/workforce/client";
import { nameSubstrings } from "../src/lib/ai/scrub";

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── PII markers ─────────────────────────────────────────────────────────
// 1) 鐵桿 marker：Apricot 病人資料欄位名 + 值格式（SSN/身份證/email）— 定義喺 ./pii-markers.ts
// 2) 決定性 bait（mock fixture 故意埋入 — 落地必須 0 hit）— 同上

type Violation = { layer: "schema" | "contract" | "data" | "log" | "summary"; detail: string };
const violations: Violation[] = [];

function add(layer: Violation["layer"], detail: string): void {
  violations.push({ layer, detail });
}

// ── 1) SCHEMA scan ──────────────────────────────────────────────────────

const CACHE_SIDE_MODELS = [
  "AvailabilitySlot",
  "WorkforceSyncState",
  "BookingRequest",
  "FlowSession",
  "Provider",
  "ProviderClinic",
];

function scanSchema(): void {
  const schema = readFileSync(path.join(__dirname, "../prisma/schema.prisma"), "utf8");
  for (const model of CACHE_SIDE_MODELS) {
    const m = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`));
    if (!m) {
      add("schema", `model ${model} 搵唔到`);
      continue;
    }
    for (const line of m[0].split("\n")) {
      const field = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+/);
      if (!field) continue;
      const fieldName = field[1];
      for (const pii of PII_FIELD_NAMES_SCHEMA) {
        // 字段名完全匹配或後綴匹配（e.g. diagnosisJson）
        if (fieldName.toLowerCase() === pii.toLowerCase() || fieldName.toLowerCase().endsWith(pii.toLowerCase())) {
          add("schema", `${model}.${fieldName} — 疑似 PII 欄位`);
        }
      }
    }
  }
  console.log(`[pii-scan] schema: ${CACHE_SIDE_MODELS.length} models checked`);
}

// ── 1b) CONTRACT-STRIP scan（workforce 切換 — 舊 Apricot bait 層換位） ──────
// raw availability response 故意插 PII 欄（模拟上游失守）→ client zod 契約必須 strip。
// 呢層零 DB — 静态可跑（gate 5：pnpm pii-scan 可跑部分綠）。

const BAIT_VALUES = ["MOCK_PII_DIAGNOSIS", "MOCK_PII_PATIENT", "85200000000", "MOCK_PII_REASON", "MOCK_PII_CREATOR"];

function scanContractStrip(): void {
  const baitRaw = {
    v: 1,
    clinicCode: "TKW",
    syncedAt: "2026-08-23T05:00:00.000Z",
    stale: false,
    days: [
      {
        date: "2026-08-24",
        providers: [
          {
            providerApricotId: "mock-pract-tkw-1",
            providerName: "Mock 醫生 1",
            slots: [{ start: "10:00", end: "10:30", isOpen: true, bookedCount: 0 }],
            // ★ PII bait（上游失守模擬）— zod 必須 strip：
            medicalHistory: "MOCK_PII_DIAGNOSIS",
            clinicPatient: { fullName: "MOCK_PII_PATIENT", phoneNum: "85200000000", dateOfBirth: "1990-01-01" },
            visitReasons: [{ des: "MOCK_PII_REASON" }],
            createdBy: "MOCK_PII_CREATOR",
          },
        ],
      },
    ],
    // 頂層 bait：
    diagnosis: "MOCK_PII_DIAGNOSIS",
  };
  let parsed: unknown;
  try {
    parsed = AvailabilityResponse.parse(baitRaw);
  } catch (e) {
    add("contract", `zod parse 失敗（bait 應該被 strip 唔係 reject）: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    console.log("[pii-scan] contract: 0 (parse failed)");
    return;
  }
  const out = JSON.stringify(parsed);
  for (const v of BAIT_VALUES) {
    if (out.includes(v)) add("contract", `zod strip 失效 — output 含 PII 值 "${v}"`);
  }
  for (const key of ["medicalHistory", "clinicPatient", "visitReasons", "createdBy", "diagnosis", "fullName", "phoneNum", "dateOfBirth"]) {
    if (out.includes(key)) add("contract", `zod strip 失效 — output 含 PII key "${key}"`);
  }
  for (const label of matchPiiMarkers(out)) add("contract", `zod strip 失效 — output 發現 "${label}"`);
  console.log("[pii-scan] contract: 1 bait-laden raw parsed (PII 欄應已 strip)");
}

// ── 2) DATA scan ────────────────────────────────────────────────────────

function grepMarkers(json: string, where: string): void {
  for (const label of matchPiiMarkers(json)) add("data", `${where}: 發現 "${label}"`);
}

async function scanData(): Promise<void> {
  const tables: Record<string, unknown[]> = {
    AvailabilitySlot: await prisma.availabilitySlot.findMany({ select: { clinicId: true, providerApricotId: true, date: true, startTime: true, endTime: true, bookedCount: true, isOpen: true, syncedAt: true } }),
    WorkforceSyncState: await prisma.workforceSyncState.findMany(),
    BookingRequest: await prisma.bookingRequest.findMany({
      select: { id: true, conversationId: true, clinicId: true, providerApricotId: true, providerName: true, requestedDate: true, requestedTime: true, timeOfDay: true, precheckPassed: true, status: true },
    }),
    FlowSession: await prisma.flowSession.findMany({ select: { id: true, conversationId: true, clinicId: true, status: true, flowMessageWamid: true } }),
    Provider: await prisma.provider.findMany(),
    ProviderClinic: await prisma.providerClinic.findMany(),
  };
  // ★ L2 cache 負面斷言（workforce 切換：來源換咗，cache 零病人欄位防線不變）：
  //   AvailabilitySlot 序列化後唔准出現任何病人資料欄位名 / PII 值格式
  const l2Json = JSON.stringify(tables.AvailabilitySlot);
  for (const key of ["clinicPatient", "visitReasons", "medicalHistory", "diagnosis", "fullName", "phoneNum", "dateOfBirth", "createdBy"]) {
    if (l2Json.includes(key)) add("data", `AvailabilitySlot（L2 cache）含病人欄位名 "${key}"`);
  }
  // ★ flowToken（BookingRequest.flowToken / FlowSession.flowToken）係簽咗 conversationId 嘅 JWT —
  //   為咗 scan 完整性用完整 row dump（token 唔係病人 PII，但 dump 住先）。
  const fullBooking = await prisma.bookingRequest.findMany({ select: { flowToken: true } });
  const fullFlow = await prisma.flowSession.findMany({ select: { flowToken: true } });
  const auditMeta = await prisma.auditLog.findMany({ select: { meta: true, action: true } });

  for (const [table, rows] of Object.entries(tables)) {
    grepMarkers(JSON.stringify(rows), table);
  }
  grepMarkers(JSON.stringify(fullBooking), "BookingRequest.flowToken");
  grepMarkers(JSON.stringify(fullFlow), "FlowSession.flowToken");
  grepMarkers(JSON.stringify(auditMeta), "AuditLog.meta");

  console.log(
    `[pii-scan] data: ${Object.entries(tables).map(([t, r]) => `${t}=${r.length}`).join(", ")} + AuditLog.meta=${auditMeta.length} rows scanned`
  );
}

// ── 3) LOG scan ─────────────────────────────────────────────────────────

function scanLogs(): void {
  const logFiles = [
    "/tmp/e2e-server.log",
    "/tmp/e2e-worker.log",
    "/tmp/e2e-worker-fail.log",
    "/tmp/e2e-worker2.log",
    "/tmp/e2e-migrate.log",
    "/tmp/e2e-seed.log",
  ];
  let checked = 0;
  for (const f of logFiles) {
    let content = "";
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    checked++;
    for (const label of matchPiiMarkers(content)) add("log", `${f}: 發現 "${label}"`);
  }
  console.log(`[pii-scan] log: ${checked} log files scanned`);
}

// ── 4) SUMMARY scan（M-5：aiSummary × profileName 子串 — scrub 生效驗證） ──

const SUMMARY_SAMPLE_LIMIT = 50;

async function scanSummaries(): Promise<void> {
  // Conversation 係 loose contactId（無 Prisma relation）→ 兩步查詢手動 join
  const convs = await prisma.conversation.findMany({
    where: { aiSummary: { not: null } },
    orderBy: { lastMessageAt: "desc" },
    take: SUMMARY_SAMPLE_LIMIT,
    select: { aiSummary: true, contactId: true },
  });
  const contactIds = [...new Set(convs.map((c) => c.contactId))];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, profileName: true, waId: true },
      })
    : [];
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  let checked = 0;
  for (const c of convs) {
    const contact = contactById.get(c.contactId);
    const summary = c.aiSummary ?? "";
    const name = (contact?.profileName ?? "").trim();
    if (name.length >= 2) {
      checked++;
      for (const sub of nameSubstrings(name)) {
        if (summary.includes(sub)) {
          // ★ 唔 print 子串本身（病人名字 = PII，CI 輸出要 metadata only）
          add("summary", `Conversation.aiSummary 含 contact.profileName 嘅 ≥2 字連續子串（sub_len=${sub.length}, name_len=${name.length}）— H-3 scrub 失效`);
          break;
        }
      }
    }
    const wa = (contact?.waId ?? "").trim();
    if (wa.length >= 8 && summary.includes(wa.slice(-8))) {
      add("summary", `Conversation.aiSummary 含 contact.waId 後 8 位 — H-3 scrub 失效`);
    }
  }
  console.log(`[pii-scan] summary: ${convs.length} aiSummary rows sampled, ${checked} × profileName substring-checked`);
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // --static = 只跑零 DB 層（schema + contract-strip + log）— 15432 down 嘅環境 gate 用
  const staticOnly = process.argv.includes("--static");
  scanSchema();
  scanContractStrip();
  if (!staticOnly) {
    await scanData();
  }
  scanLogs();
  if (!staticOnly) {
    await scanSummaries();
  }
  if (staticOnly) console.log("[pii-scan] --static: DB 層（data/summary）已 skip");

  if (violations.length === 0) {
    console.log("PII-SCAN OK: 0 violations");
  } else {
    console.error(`PII-SCAN FAILED: ${violations.length} violations:`);
    for (const v of violations.slice(0, 20)) {
      console.error(`  [${v.layer}] ${v.detail}`);
    }
    if (violations.length > 20) console.error(`  ... +${violations.length - 20} more`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[pii-scan] error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
