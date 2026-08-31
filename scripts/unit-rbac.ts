/**
 * unit-rbac — cwi-h6-20260830 P1：多店 RBAC 純函數 unit tests
 *
 * 範圍（MD §1）：
 *   C1 clinicScope(ADMIN) → {}（跨店）
 *   C2 clinicScope(STAFF, [A,B]) → { clinicId: { in: [A,B] } }（多店集合）
 *   C3 clinicScope(STAFF, []) → throw 401（fail-closed：壞 session 唔可以變無 scope）
 *
 *   A1 assertConversationAccess(ADMIN, 任何店/任何 assignee) → 通過
 *   A2 assertConversationAccess(STAFF, conv.clinicId ∈ 自己店集合) → 通過
 *   A3 assertConversationAccess(STAFF, conv.assigneeId == 自己，外店) → 通過（單線授權）
 *   A4 assertConversationAccess(STAFF, 外店 且 非 assignee) → throw 403
 *
 * 純函數測試（唔落 DB）。
 * 用法（repo root）：pnpm test:unit-rbac
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { clinicScope, assertConversationAccess, conversationScope } from "../src/lib/rbac";

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

const ADMIN = { staff: { role: "ADMIN" as const, id: "adm1", email: "a@x", name: "A" }, clinicIds: [] as string[] };
const STAFF_A = { staff: { role: "STAFF" as const, id: "stf1", email: "s1@x", name: "S1" }, clinicIds: ["cA"] };
const STAFF_AB = { staff: { role: "STAFF" as const, id: "stf2", email: "s2@x", name: "S2" }, clinicIds: ["cA", "cB"] };
const STAFF_EMPTY = { staff: { role: "STAFF" as const, id: "stf3", email: "s3@x", name: "S3" }, clinicIds: [] as string[] };

// ── clinicScope（3 case）───────────────────────────────────────────────
check(
  "C1 clinicScope(ADMIN) → {}",
  JSON.stringify(clinicScope(ADMIN)) === "{}"
);

const scopeAB = clinicScope(STAFF_AB);
check(
  "C2 clinicScope(STAFF,[A,B]) → { clinicId: { in: [A,B] } }",
  scopeAB.clinicId?.in?.length === 2 &&
    scopeAB.clinicId.in[0] === "cA" &&
    scopeAB.clinicId.in[1] === "cB",
  JSON.stringify(scopeAB)
);

let c3threw = false;
let c3status = 0;
try {
  clinicScope(STAFF_EMPTY);
} catch (e) {
  c3threw = true;
  c3status = (e as { status?: number }).status ?? 0;
}
check("C3 clinicScope(STAFF,[]) → throw 401（fail-closed）", c3threw && c3status === 401, `threw=${c3threw} status=${c3status}`);

// ── assertConversationAccess（4 路徑）──────────────────────────────────
let a1ok = true;
try {
  assertConversationAccess(ADMIN, { clinicId: "cZ", assigneeId: "someoneElse" });
} catch {
  a1ok = false;
}
check("A1 ADMIN → 任何對話都通過", a1ok);

let a2ok = true;
try {
  assertConversationAccess(STAFF_AB, { clinicId: "cB", assigneeId: "someoneElse" });
} catch {
  a2ok = false;
}
check("A2 STAFF 店 ∈ 集合（cB）→ 通過", a2ok);

let a3ok = true;
try {
  assertConversationAccess(STAFF_A, { clinicId: "cZ", assigneeId: "stf1" }); // 外店 cZ 但我是 assignee
} catch {
  a3ok = false;
}
check("A3 STAFF 外店但 assignee == 自己（單線授權）→ 通過", a3ok);

let a4threw = false;
let a4status = 0;
try {
  assertConversationAccess(STAFF_A, { clinicId: "cZ", assigneeId: "someoneElse" });
} catch (e) {
  a4threw = true;
  a4status = (e as { status?: number }).status ?? 0;
}
check("A4 STAFF 外店且非 assignee → throw 403", a4threw && a4status === 403, `threw=${a4threw} status=${a4status}`);

// ── 附加：conversationScope（列表層單線授權）────────────────────────────
const listAB = conversationScope(STAFF_AB);
check(
  "L1 conversationScope(STAFF) → OR[clinicId in, assigneeId=self]",
  Array.isArray((listAB.OR as unknown[]) ?? null) &&
    (listAB.OR as { assigneeId?: string }[]).some((o) => o.assigneeId === "stf2")
);
check("L2 conversationScope(ADMIN) → {}", JSON.stringify(conversationScope(ADMIN)) === "{}");

console.log(`\nunit-rbac: ${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
