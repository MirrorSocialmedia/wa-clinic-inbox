/**
 * ★ cwi-qa FX-02：建員工請求嘅 scopeType 解析（純函數，唔帶副作用 — 俾 unit test 直接驗）。
 *
 * 背景：QA-02 實測 — 建 ADMIN 唔帶 scopeType 時靠 code/DB default 兜底，新環境 seed 出
 * 空範圍 ADMIN（CLINICS + 零 StaffClinic）→ T19 等 global-admin case 403。
 * 修：ADMIN 必須顯式帶 scopeType（冇 → 400）；SUPERVISOR 恆 ALL（現行無 scope 概念）；
 * STAFF 唔帶 → CLINICS（現行語義唔變）。
 */
export type CreateRole = "ADMIN" | "STAFF" | "SUPERVISOR";

export function resolveCreateScopeType(d: {
  role: CreateRole;
  scopeType?: "ALL" | "COMPANY" | "CLINICS";
}): { ok: true; scopeType: "ALL" | "COMPANY" | "CLINICS" } | { ok: false; status: 400; error: string; message: string } {
  if (d.role === "ADMIN" && d.scopeType === undefined) {
    return {
      ok: false,
      status: 400,
      error: "SCOPE_TYPE_REQUIRED",
      message: "建立 ADMIN 必須顯式帶 scopeType（ALL / COMPANY / CLINICS）",
    };
  }
  if (d.role === "SUPERVISOR") return { ok: true, scopeType: "ALL" };
  if (d.role === "ADMIN") return { ok: true, scopeType: d.scopeType! };
  return { ok: true, scopeType: d.scopeType ?? "CLINICS" };
}
