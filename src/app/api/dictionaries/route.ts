/**
 * GET /api/dictionaries?kind=VISIT_REASON|BOOKING_TYPE — 代落單卡 visitReason 下拉（booking-ui D）
 *
 * workforce 窄 API 包裝（client 內置 1 小時 memory cache — MD B）。
 * 只回白名單欄位 { apricotId, code, des }（zod strict 已 strip 多餘欄位）。
 * ★ cwi-apricotty-20261001：可帶 clinicId — 青衣（TY）係另一個 Apricot 帳號，字典 id 唔同；
 *   唔帶 = workforce 預設帳號（舊口徑）。字典係代碼表（零病人資料）→ 照舊 authenticated staff 就攞得。
 *
 * VISIT_REASON 附加 defaultCode（env BOOKING_DEFAULT_VISIT_REASON_CODE — 前端預揀下拉；
 * 空 = 未設定 → null → 前端要 staff 手揀；create route 冇 body 時都會 fallback 呢個 env）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { defaultVisitReasonCode, fetchDictionaries } from "@/lib/workforce/client";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);

  const kind = req.nextUrl.searchParams.get("kind");
  if (kind !== "VISIT_REASON" && kind !== "BOOKING_TYPE") {
    return NextResponse.json({ error: "kind must be VISIT_REASON or BOOKING_TYPE" }, { status: 400 });
  }

  const clinicId = req.nextUrl.searchParams.get("clinicId");
  let clinicCode: string | null = null;
  if (clinicId) {
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { code: true } });
    if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 404 });
    clinicCode = clinic.code;
  }

  const data = await fetchDictionaries(kind, clinicCode);
  const defaultCode = kind === "VISIT_REASON" ? defaultVisitReasonCode() : null;
  return NextResponse.json({ kind: data.kind, items: data.items, defaultCode });
});
