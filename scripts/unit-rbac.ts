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
 *   ★ cwi-auditfix-20260908（B-1，assertConversationAccess 改 async + 第四條放行）：
 *   A5  STAFF 外店 + routedStaffId == 自己 → 通過（路由單線授權 — 純記憶體判斷）
 *   A6b STAFF 外店 + routedGroupId ∈ 我組 但 DB 不可用 → fail-closed 403（唔假放行）
 *       （A6 happy path 要打 DB 查我組 — 純函數環境唔測，由 e2e T290 實測）
 *
 * 純函數測試（唔落 DB — 本 script 預設 DATABASE_URL 指唔到 DB 時 prisma query fail-soft）。
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

async function main(): Promise<void> {
  // ── clinicScope（3 case）───────────────────────────────────────────
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

  // ── assertConversationAccess（B-1 後改 async — 全部 await）────────────
  let a1ok = true;
  try {
    await assertConversationAccess(ADMIN, { clinicId: "cZ", assigneeId: "someoneElse" });
  } catch {
    a1ok = false;
  }
  check("A1 ADMIN → 任何對話都通過", a1ok);

  let a2ok = true;
  try {
    await assertConversationAccess(STAFF_AB, { clinicId: "cB", assigneeId: "someoneElse" });
  } catch {
    a2ok = false;
  }
  check("A2 STAFF 店 ∈ 集合（cB）→ 通過", a2ok);

  let a3ok = true;
  try {
    await assertConversationAccess(STAFF_A, { clinicId: "cZ", assigneeId: "stf1" }); // 外店 cZ 但我是 assignee
  } catch {
    a3ok = false;
  }
  check("A3 STAFF 外店但 assignee == 自己（單線授權）→ 通過", a3ok);

  let a4threw = false;
  let a4status = 0;
  try {
    await assertConversationAccess(STAFF_A, { clinicId: "cZ", assigneeId: "someoneElse" });
  } catch (e) {
    a4threw = true;
    a4status = (e as { status?: number }).status ?? 0;
  }
  check("A4 STAFF 外店且非 assignee → throw 403", a4threw && a4status === 403, `threw=${a4threw} status=${a4status}`);

  // ★ cwi-auditfix-20260908（B-1）：路由單線授權
  let a5ok = true;
  try {
    // 外店 cZ + 非 assignee + routedStaffId == 自己 → 第四條放行（純記憶體判斷 — 唔打 DB）
    await assertConversationAccess(STAFF_A, { clinicId: "cZ", assigneeId: null, routedStaffId: "stf1", routedGroupId: null });
  } catch {
    a5ok = false;
  }
  check("A5 STAFF 外店但 routedStaffId == 自己（路由單線授權）→ 通過", a5ok);

  // A6b：routedGroupId 支路要打 DB 查我組；呢度（純函數環境）DB 不可用 →
  // myGroupIds fail-closed 空集合 → 403（路由支路唔可以假放行）。
  // happy path（真 DB 入面我組含 grpX → 通過）由 e2e T290 實測。
  let a6bthrew = false;
  let a6bstatus = 0;
  try {
    await assertConversationAccess(STAFF_A, { clinicId: "cZ", assigneeId: null, routedStaffId: null, routedGroupId: "grpX" });
  } catch (e) {
    a6bthrew = true;
    a6bstatus = (e as { status?: number }).status ?? 0;
  }
  check("A6b STAFF 外店 + routedGroupId 但 DB 不可用 → fail-closed 403（唔假放行）", a6bthrew && a6bstatus === 403, `threw=${a6bthrew} status=${a6bstatus}`);

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
