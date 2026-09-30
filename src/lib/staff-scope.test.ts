/**
 * FX-02 unit test — resolveCreateScopeType（src/lib/staff-scope.ts）
 *
 * 運行：TZ=UTC npx tsx --test src/lib/staff-scope.test.ts
 *
 * 驗收（workorder FX-02 ②）：admin/staff POST — role===ADMIN 冇帶 scopeType → 400
 * （唔准靠 schema default）。呢度直接驗純函數，覆蓋 8 個角色×scopeType 組合。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCreateScopeType } from "./staff-scope";

test("ADMIN without scopeType → 400 SCOPE_TYPE_REQUIRED（唔准靠 default 兜底）", () => {
  const r = resolveCreateScopeType({ role: "ADMIN" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.equal(r.error, "SCOPE_TYPE_REQUIRED");
    assert.ok(r.message.length > 0);
  }
});

test("ADMIN + ALL → ALL（全集團）", () => {
  const r = resolveCreateScopeType({ role: "ADMIN", scopeType: "ALL" });
  assert.deepEqual(r, { ok: true, scopeType: "ALL" });
});

test("ADMIN + CLINICS → CLINICS（scoped admin 顯式建）", () => {
  const r = resolveCreateScopeType({ role: "ADMIN", scopeType: "CLINICS" });
  assert.deepEqual(r, { ok: true, scopeType: "CLINICS" });
});

test("ADMIN + COMPANY → COMPANY", () => {
  const r = resolveCreateScopeType({ role: "ADMIN", scopeType: "COMPANY" });
  assert.deepEqual(r, { ok: true, scopeType: "COMPANY" });
});

test("SUPERVISOR without scopeType → ALL（現行全店語義唔變）", () => {
  const r = resolveCreateScopeType({ role: "SUPERVISOR" });
  assert.deepEqual(r, { ok: true, scopeType: "ALL" });
});

test("SUPERVISOR + 任何值 → 一律 ALL（SUPERVISOR 無 scope 概念，唔接受覆蓋）", () => {
  assert.deepEqual(resolveCreateScopeType({ role: "SUPERVISOR", scopeType: "CLINICS" }), { ok: true, scopeType: "ALL" });
  assert.deepEqual(resolveCreateScopeType({ role: "SUPERVISOR", scopeType: "COMPANY" }), { ok: true, scopeType: "ALL" });
});

test("STAFF without scopeType → CLINICS（現行語義唔變）", () => {
  const r = resolveCreateScopeType({ role: "STAFF" });
  assert.deepEqual(r, { ok: true, scopeType: "CLINICS" });
});

test("STAFF + CLINICS → CLINICS", () => {
  const r = resolveCreateScopeType({ role: "STAFF", scopeType: "CLINICS" });
  assert.deepEqual(r, { ok: true, scopeType: "CLINICS" });
});
