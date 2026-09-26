import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { phoneHash } from "@/lib/phone-hash";
import { hkDateOffset } from "@/lib/availability";
import { lookupPatient, fetchAppointments, fetchCompanies, WorkforceApiError, type PatientLookupResult } from "@/lib/workforce/client";

/**
 * GET /api/conversations/[id]/patient-context — 側欄 patient-context（booking-ui MD §1 A）
 *
 * 一次回三件：
 *  1. pinned — 已釘住舊客（Conversation 3 欄）
 *  2. matches — lookup 結果（未釘住時供 staff 揀；釘咗之後亦回，供對照/換釘）
 *  3. upcomingAppointments — 已釘住舊客嘅 upcoming 預約（status 0/102，本店；側欄 Apricot 卡 E）
 *
 * PII 鐵律：raw phone（contact.waId）只喺 server 端算 phoneHash，唔入 response / log；
 *   response 只含 Apricot 欄位 + 姓名（PII 白名單 v2 許可）。
 *   lookup / appointments 任一端點 fail（workforce 離線）→ degraded=true + 對應欄 null（UI 顯示降級提示，唔 block 其餘）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });

  const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId }, select: { code: true, companyId: true } });
  if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 500 });

  // ★ raw phone 只喺呢度轉 hash（phone-hash.ts 同 clinic-workforce 逐字一樣 — 同 phone → 同 hash）
  const hash = phoneHash(contact.waId);

  // lookup（fail → degraded，唔 throw）
  // ★ S5-13②：EnrichedMatch = CWM lookup 結果 + W 端計算嘅跨公司黃標（outsideCompany — CWM 唔回，W 計算）
  type EnrichedMatch = PatientLookupResult["matches"][number] & { outsideCompany?: boolean };
  let matches: EnrichedMatch[] | null = null;
  let degraded = false;
  try {
    const lk = await lookupPatient(hash);
    matches = lk.matches;
  } catch (e) {
    degraded = true;
    log.warn(
      { conversationId: conv.id, clinic: clinic.code, err: e instanceof WorkforceApiError ? `status=${e.status}` : e instanceof Error ? e.name : "unknown" },
      "patient-context: lookup degraded（workforce 離線/錯誤）"
    );
  }

  // ★ cwi-final S5-13②：跨公司黃標（C-8 唔阻）— 當前對話公司（sourceId = CWM Company.id）嘅 CWM clinic 集合。
  //   null = 判斷唔到（店未配公司 / sourceId 未配對 / companies API 失敗）→ 唔標黃（fail-soft）。
  //   visitedClinicIds 空（冇任何到診行）→ 唔標（「無記錄」已有其他顯示）。
  let companyClinicIds: Set<string> | null = null;
  if (matches && matches.some((m) => (m.visitedClinicIds ?? []).length > 0)) {
    const company = clinic.companyId ? await prisma.company.findUnique({ where: { id: clinic.companyId }, select: { sourceId: true } }) : null;
    if (company?.sourceId) {
      try {
        const orgs = await fetchCompanies();
        const mine = orgs.companies.find((c) => c.id === company.sourceId);
        if (mine) companyClinicIds = new Set(mine.clinics.map((c) => c.id));
      } catch (e) {
        log.warn(
          { conversationId: conv.id, clinic: clinic.code, err: e instanceof WorkforceApiError ? `status=${e.status}` : e instanceof Error ? e.name : "unknown" },
          "patient-context: companies degraded（黃標唔顯示）"
        );
      }
    }
  }
  if (matches) {
    for (const m of matches) {
      const visited = m.visitedClinicIds ?? [];
      if (companyClinicIds !== null && visited.length > 0 && visited.every((v) => !companyClinicIds.has(v))) {
        m.outsideCompany = true;
      }
    }
  }

  const pinned = conv.pinnedPatientApricotId
    ? {
        patientApricotId: conv.pinnedPatientApricotId,
        patientName: conv.pinnedPatientName ?? undefined,
        lastVisit: matches?.find((m) => m.patientApricotId === conv.pinnedPatientApricotId)?.lastVisit ?? null,
      }
    : null;

  // upcoming appointments（只有釘咗先查；窗口 38 日內，status 0/1，本店）
  // ★ cwi-final S5-7（F2）：102 = 舊單已改期 → 排除（唔再顯示做「將來預約」；0 = booked / 1 = arrived）
  let upcomingAppointments: unknown[] | null = null;
  if (conv.pinnedPatientApricotId) {
    try {
      const appts = await fetchAppointments(hash, hkDateOffset(-7), hkDateOffset(30));
      upcomingAppointments = appts.appointments.filter(
        (a) =>
          a.patientApricotId === conv.pinnedPatientApricotId &&
          a.clinicCode === clinic.code &&
          (a.bookingStatus === 0 || a.bookingStatus === 1)
      );
    } catch (e) {
      degraded = true;
      log.warn(
        { conversationId: conv.id, clinic: clinic.code, err: e instanceof WorkforceApiError ? `status=${e.status}` : e instanceof Error ? e.name : "unknown" },
        "patient-context: appointments degraded"
      );
    }
  }

  return NextResponse.json({
    pinned,
    matches,
    upcomingAppointments,
    degraded,
  });
});
