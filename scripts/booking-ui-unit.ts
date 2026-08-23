/**
 * booking-ui-unit — 非 DB unit tests（booking-ui D/E — MD F-4：本地必綠）
 *
 * 範圍（零 DB / 零 Redis — 只 pure 邏輯）：
 *   1. 5 分鐘撤銷倒數邊界 — rollbackWindowOpen（server 端窗口）
 *   2. 卡倒數顯示 — formatMmSs / rollbackButtonVisible（client 端邊界，同 server 窗口對齊）
 *   3. L2 invalidate 純 where — dayInvalidateWhere（clinicId+date 精確命中）
 *   4. 訊息文字 — confirmMessageText / buildRemarks / cancelMessageText / rescheduledReply
 *
 * mock 契約 sha256 錨定 + 409 分支 → 見 scripts/booking-ui-contract.ts（pnpm e2e:booking-ui-contract）
 *
 * 用法（repo root）：pnpm test:booking-ui-unit
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// pure imports（無 DB 連接 — prisma/redis 都係 lazy connect）
import { formatMmSs, rollbackButtonVisible } from "../src/components/inbox/booking-card";
import { ROLLBACK_WINDOW_MS, dayInvalidateWhere, rollbackWindowOpen } from "../src/lib/booking/booking-ops";
import {
  buildRemarks,
  cancelMessageText,
  confirmMessageText,
  rescheduledReply,
} from "../src/lib/booking/booking-text";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 50; // ±50ms 容差（時序斷言）
}

const NOW = Date.now();
const nowD = new Date(NOW);
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (ms: number): Date => new Date(ms);

async function main(): Promise<void> {
  // ── 1. server 端 5 分鐘撤銷窗口（rollbackWindowOpen）────────────────────
  console.log("\n[1] 5 分鐘撤銷窗口（server 端）");
  check("null handledAt → 關閉", rollbackWindowOpen(null, nowD) === false);
  check("future handledAt → 關閉", rollbackWindowOpen(at(NOW + 60_000), nowD) === false);
  check("4:59 → 開", rollbackWindowOpen(at(NOW - (5 * 60_000 - 1_000)), nowD) === true);
  check("exactly 5:00 → 開（邊界含）", rollbackWindowOpen(at(NOW - 5 * 60_000), nowD) === true);
  check("5:01 → 關", rollbackWindowOpen(at(NOW - (5 * 60_000 + 1_000)), nowD) === false);
  check("10 分鐘 → 關", rollbackWindowOpen(at(NOW - 10 * 60_000), nowD) === false);

  // ── 2. client 端倒數顯示邊界（同 server 窗口對齊）───────────────────────
  console.log("\n[2] 卡倒數顯示（formatMmSs / rollbackButtonVisible）");
  check("formatMmSs(0) = 00:00", formatMmSs(0) === "00:00");
  check("formatMmSs(negative) = 00:00", formatMmSs(-1) === "00:00");
  check("formatMmSs(59.9s) = 01:00（ceil）", formatMmSs(59_900) === "01:00");
  check("formatMmSs(60s) = 01:00", formatMmSs(60_000) === "01:00");
  check("formatMmSs(5:00) = 05:00", formatMmSs(300_000) === "05:00");
  check("formatMmSs(4:59.9) = 05:00（ceil 唔會跳 05:01）", formatMmSs(299_999) === "05:00");
  check("formatMmSs(1:31.5) = 01:32", formatMmSs(91_500) === "01:32");

  check("visible: null handledAt → 隱藏", rollbackButtonVisible(null, NOW) === false);
  check("visible: 4:59 → 顯示", rollbackButtonVisible(iso(NOW - (300_000 - 1_000)), NOW) === true);
  check("visible: exactly 5:00 → 顯示（邊界含，同 server 對齊）", rollbackButtonVisible(iso(NOW - 300_000), NOW) === true);
  check("visible: 5:01 → 消失", rollbackButtonVisible(iso(NOW - (300_000 + 1_000)), NOW) === false);
  check("visible: future → 隱藏", rollbackButtonVisible(iso(NOW + 1_000), NOW) === false);
  check("server/client 窗口同用 5min 常數", approx(ROLLBACK_WINDOW_MS, 5 * 60_000));

  // ── 3. L2 invalidate 純 where ───────────────────────────────────────────
  console.log("\n[3] L2 invalidate where（clinicId+date 精確命中）");
  const w = dayInvalidateWhere("clinic-1", "2026-08-25");
  check("where.clinicId", w.clinicId === "clinic-1");
  check("where.date", w.date === "2026-08-25");
  check("where 無其他欄（唔會誤刪其他日/舖）", Object.keys(w).sort().join(",") === "clinicId,date");

  // ── 4. 訊息文字 builders ────────────────────────────────────────────────
  console.log("\n[4] 訊息文字（確認/取消/改期/remarks）");
  check(
    "confirm: 具體時段",
    confirmMessageText({ requestedDate: "2026-09-02", requestedTime: "10:30", providerName: "陳醫生" }) ===
      "已為你預約 9月2日 10:30 陳醫生，到時見 🙂"
  );
  check(
    "confirm: 純時段偏好",
    confirmMessageText({ requestedDate: "2026-09-02", requestedTime: null, providerName: "陳醫生", timeOfDay: "MORNING" }) ===
      "已為你預約 9月2日 上晝 陳醫生，具體時段職員會再同你確認 🙂"
  );
  check(
    "cancel 文字",
    cancelMessageText("2026-09-02") === "已為你取消 9月2日嘅預約，有需要隨時搵我哋 🙏"
  );
  check(
    "reschedule 文字",
    rescheduledReply("2026-09-02", "14:00") === "已為你改至 9月2日 14:00"
  );
  check(
    "remarks: 主訴+code",
    buildRemarks("牙痛三日", "0010") === "WhatsApp booking · Chief complaint: 牙痛三日 · Visit reason: 0010"
  );
  check("remarks: 無主訴", buildRemarks(null, null) === "WhatsApp booking");
  check("remarks: 空串視作無", buildRemarks("   ", "0010") === "WhatsApp booking · Visit reason: 0010");
  check(
    "remarks: 主訴 >50 字截斷",
    buildRemarks("x".repeat(80), null) === `WhatsApp booking · Chief complaint: ${"x".repeat(50)}`
  );

  // ── 5. phone-hash.ts byte-identical anchor（鐵律 1）─────────────────────
  console.log("\n[5] phone-hash.ts anchor（逐字 copy 驗證）");
  const raw = readFileSync(path.resolve(process.cwd(), "src/lib/phone-hash.ts"));
  const sha = createHash("sha256").update(raw).digest("hex");
  const md5 = createHash("md5").update(raw).digest("hex");
  check(
    "sha256 = 06f2ac3d…",
    sha === "06f2ac3d3032e3bc003e1830bccf7d2b0dd9519452e3a8136059fba69b5931bb",
    sha
  );
  check("md5 = 433a88c8…", md5 === "433a88c8483e43b3a0f07115735ba1d4", md5);

  // ── summary ─────────────────────────────────────────────────────────────
  console.log(failures === 0 ? "\nUNIT PASS ✅（booking-ui unit）" : `\nUNIT FAIL ❌（${failures} 項）`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
