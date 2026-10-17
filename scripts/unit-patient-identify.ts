/**
 * cwi-patient-identify-20261017：新客／舊客判定規則 unit（純函數 — 零 DB／零網絡）
 * 用法：npx tsx scripts/unit-patient-identify.ts
 */
import { needsIdentify, mapIdentifyStatus, FRESH_MS, RETRY_UNKNOWN_MS } from "../src/lib/patient-identify-policy";

let fails = 0;
function check(name: string, ok: boolean): void {
  if (!ok) fails++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
}
const now = Date.parse("2026-10-17T08:00:00Z");
const ago = (ms: number) => new Date(now - ms);

check("未判定 → 查", needsIdentify({ patientStatus: null, patientCheckedAt: null }, now));
check("舊客 1 小時前判定 → 唔查", !needsIdentify({ patientStatus: "EXISTING", patientCheckedAt: ago(3600_000) }, now));
check("新客 1 小時前判定 → 唔查", !needsIdentify({ patientStatus: "NEW", patientCheckedAt: ago(3600_000) }, now));
check("舊客超過 24h → 再查", needsIdentify({ patientStatus: "EXISTING", patientCheckedAt: ago(FRESH_MS + 1) }, now));
check("未確定 5 分鐘前 → 唔查（避免狂打 Apricot）", !needsIdentify({ patientStatus: "UNKNOWN", patientCheckedAt: ago(5 * 60_000) }, now));
check("未確定超過 10 分鐘 → 再查", needsIdentify({ patientStatus: "UNKNOWN", patientCheckedAt: ago(RETRY_UNKNOWN_MS + 1) }, now));
check("FOUND → EXISTING（已登記未到診都算舊客）", mapIdentifyStatus("FOUND") === "EXISTING");
check("NOT_FOUND → NEW", mapIdentifyStatus("NOT_FOUND") === "NEW");
check("PARTIAL → UNKNOWN（有帳號查唔到唔當新客）", mapIdentifyStatus("PARTIAL") === "UNKNOWN");

console.log(fails ? `\n[unit-patient-identify] ${fails} FAILED` : "\n[unit-patient-identify] all passed");
process.exit(fails ? 1 : 0);
