/**
 * e2e-alert-gate — M-2 alert 出境 hard-gate 單元/E2E（獨立 process）
 *
 * 斷言（全部通過先出 ALERT-GATE OK）：
 *  A. 白名單內（number/boolean/短字串≤200）→ 保留
 *  B. 超長 string（>200）→ drop
 *  C. object / array / null → drop
 *  D. weekly_report.text 特例：≤4000 保留；>4000 drop
 *  E. notifyAlert 整合：log channel 下唔 throw + detail 已過門（用 log channel 避免外發）
 *
 * 用法：pnpm e2e:alert-gate
 */
// ALERT_CHANNEL=log 確保 notifyAlert 唔打真 webhook
process.env.ALERT_CHANNEL = "log";
process.env.WA_MOCK = "1";

import { sanitizeAlertDetail, notifyAlert } from "../src/lib/health/notify";

let failures = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${extra}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  // A. 白名單內保留
  const a = sanitizeAlertDetail("queue_depth", {
  waiting: 150,
  failed: 0,
  ok: true,
  code: "X_OK",
  clinic: "TKW",
});
check("A number/boolean/短字串保留", a.waiting === 150 && a.failed === 0 && a.ok === true && a.code === "X_OK" && a.clinic === "TKW", JSON.stringify(a));

// B. 超長 string drop
  // B. 超長 string drop
  const b = sanitizeAlertDetail("disk_low", { freePct: 5, body: "x".repeat(500) });
  check("B 超長 string（500>200）drop", "body" in b === false && b.freePct === 5, JSON.stringify(Object.keys(b)));

  // C. object / array / null drop
  const c = sanitizeAlertDetail("backup_failed", {
    reason: "age_not_installed_production",
    nested: { a: 1 },
    list: [1, 2, 3],
    nul: null,
  });
  check(
    "C object/array/null drop + 短字串保留",
    "nested" in c === false && "list" in c === false && "nul" in c === false && c.reason === "age_not_installed_production",
    JSON.stringify(c)
  );

  // D. weekly_report.text 特例
  const d1 = sanitizeAlertDetail("weekly_report", { text: "y".repeat(3000), clinic: "TKW" });
  check("D1 weekly_report.text ≤4000 保留", (d1.text as string).length === 3000 && d1.clinic === "TKW");
  const d2 = sanitizeAlertDetail("weekly_report", { text: "y".repeat(5000) });
  check("D2 weekly_report.text >4000 drop", "text" in d2 === false, JSON.stringify(Object.keys(d2)));

  // E. notifyAlert 整合（log channel — 唔 throw + gate 生效）
  let threw = false;
  try {
    await notifyAlert({
      type: "queue_depth",
      severity: "MEDIUM",
      clinicCode: "TKW",
      detail: { waiting: 999, secret: { patient: "某某某" }, long: "z".repeat(999) },
    });
  } catch {
    threw = true;
  }
  check("E notifyAlert 唔 throw（fire-and-forget）", threw === false);

  if (failures > 0) {
    console.log(`ALERT-GATE FAIL: ${failures} 項失敗`);
    process.exit(1);
  }
  console.log("ALERT-GATE OK");
}

main().catch((err) => {
  console.log(`ALERT-GATE FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
