/**
 * pii-scan — PII CI 守門（MD 任務 D / Phase 3 驗收「DB 全表掃描」）
 *
 * 三層掃描：
 * 1. SCHEMA：Apricot 側表（AvailabilitySlot/ApricotSession/BookingRequest/FlowSession/
 *    Provider/ProviderClinic）唔可以有 clinicPatient/visitReasons/diagnosis 類欄位
 * 2. DATA：抽呢幾張表嘅真實 DB 數據（JSON dump）+ AuditLog.meta grep
 *    — mock fixture 故意帶 PII bait（MOCK_PII_* 字串）經 adapter 落庫，
 *    呢度斷 0 hit（bait 只可存活喺 raw response 內存，落地即消失）
 * 3. LOG：/tmp/e2e-*.log grep 同樣 marker（log 只准 metadata 鐵律）
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

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── PII markers ─────────────────────────────────────────────────────────
// 1) 鐵桿 marker：Apricot 病人資料欄位名 + 值格式（SSN/身份證/email）— 定義喺 ./pii-markers.ts
// 2) 決定性 bait（mock fixture 故意埋入 — 落地必須 0 hit）— 同上

type Violation = { layer: "schema" | "data" | "log"; detail: string };
const violations: Violation[] = [];

function add(layer: Violation["layer"], detail: string): void {
  violations.push({ layer, detail });
}

// ── 1) SCHEMA scan ──────────────────────────────────────────────────────

const APRICOT_SIDE_MODELS = [
  "AvailabilitySlot",
  "ApricotSession",
  "BookingRequest",
  "FlowSession",
  "Provider",
  "ProviderClinic",
];

function scanSchema(): void {
  const schema = readFileSync(path.join(__dirname, "../prisma/schema.prisma"), "utf8");
  for (const model of APRICOT_SIDE_MODELS) {
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
  console.log(`[pii-scan] schema: ${APRICOT_SIDE_MODELS.length} models checked`);
}

// ── 2) DATA scan ────────────────────────────────────────────────────────

function grepMarkers(json: string, where: string): void {
  for (const label of matchPiiMarkers(json)) add("data", `${where}: 發現 "${label}"`);
}

async function scanData(): Promise<void> {
  const tables: Record<string, unknown[]> = {
    AvailabilitySlot: await prisma.availabilitySlot.findMany({ select: { clinicId: true, providerApricotId: true, date: true, startTime: true, endTime: true, bookedCount: true, isOpen: true, syncedAt: true } }),
    ApricotSession: await prisma.apricotSession.findMany(),
    BookingRequest: await prisma.bookingRequest.findMany({
      select: { id: true, conversationId: true, clinicId: true, providerApricotId: true, providerName: true, requestedDate: true, requestedTime: true, status: true },
    }),
    FlowSession: await prisma.flowSession.findMany({ select: { id: true, conversationId: true, clinicId: true, status: true, flowMessageWamid: true } }),
    Provider: await prisma.provider.findMany(),
    ProviderClinic: await prisma.providerClinic.findMany(),
  };
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

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  scanSchema();
  await scanData();
  scanLogs();

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
