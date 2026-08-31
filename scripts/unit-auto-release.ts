/**
 * unit-auto-release — cwi-h6-20260830 P2：shouldAutoRelease 三條件 pure unit tests
 *
 * ★ 偏差聲明（缺口 3）：MD §7 引「h5 §7 原文」六 case，但 h5 無檔 — 呢六個 case 係由三條件
 * （有未覆訊息 ∧ 病人等夠 N ∧ 負責人齋夠 N）推導：
 *   AR1 三條件全真（T,T,T）→ true（踢中 case）
 *   AR2 冇未覆訊息（F,T,T）→ false（已覆）
 *   AR3 病人等唔夠 N（T,F,T）→ false
 *   AR4 負責人冇齋夠 N（T,T,F）→ false
 *   AR5 三條件全假（F,F,F）→ false
 *   AR6 邊界：病人/負責人恰好等夠 N → true（「等夠」= ≥ 語義）
 *
 * 純函數測試（now 注入 — deterministic，唔落 DB）。
 * 用法（repo root）：pnpm test:unit-auto-release
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { shouldAutoRelease, type AutoReleaseCandidate } from "../src/lib/auto-release";

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

const N_MIN = 15;
const NOW = new Date("2026-09-01T12:00:00Z");
const min = (m: number) => new Date(NOW.getTime() - m * 60_000);

function conv(over: Partial<AutoReleaseCandidate>): AutoReleaseCandidate {
  return {
    id: "cv-test",
    clinicId: "cl-test",
    assigneeId: "st-test",
    unreadCount: 1,
    lastInboundAt: min(20),
    assigneeLastActionAt: min(20),
    ...over,
  };
}

check(
  "AR1 三條件全真（有未覆 + 病人等 20m≥15m + 負責人齋 20m≥15m）→ true",
  shouldAutoRelease(conv({}), N_MIN, NOW) === true
);
check(
  "AR2 冇未覆訊息（unread=0，已覆）→ false",
  shouldAutoRelease(conv({ unreadCount: 0 }), N_MIN, NOW) === false
);
check(
  "AR3 病人等唔夠 N（lastInbound 5m < 15m）→ false",
  shouldAutoRelease(conv({ lastInboundAt: min(5) }), N_MIN, NOW) === false
);
check(
  "AR4 負責人冇齋夠 N（lastAction 10m < 15m）→ false",
  shouldAutoRelease(conv({ assigneeLastActionAt: min(10) }), N_MIN, NOW) === false
);
check(
  "AR5 三條件全假（unread=0 + 病人 1m + 負責人 1m）→ false",
  shouldAutoRelease(conv({ unreadCount: 0, lastInboundAt: min(1), assigneeLastActionAt: min(1) }), N_MIN, NOW) ===
    false
);
check(
  "AR6 邊界：恰好等夠 N（病人 15m = 負責人 15m，≥ 語義）→ true",
  shouldAutoRelease(conv({ lastInboundAt: min(15), assigneeLastActionAt: min(15) }), N_MIN, NOW) === true
);
check(
  "AR7（附加）lastInboundAt = null（病人從未開口？— 等唔夠）→ false",
  shouldAutoRelease(conv({ lastInboundAt: null }), N_MIN, NOW) === false
);
check(
  "AR8（附加）assigneeLastActionAt = null（未記錄 → 視為 idle）+ 其餘全真 → true",
  shouldAutoRelease(conv({ assigneeLastActionAt: null }), N_MIN, NOW) === true
);

console.log(`\nunit-auto-release: ${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
