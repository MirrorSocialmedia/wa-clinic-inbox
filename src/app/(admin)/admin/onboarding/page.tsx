import { getServerSession } from "@/lib/session-server";
import { unauthorized, forbidden } from "next/navigation";
import prisma from "@/lib/prisma";
import { OnboardingClient, type OnboardingClinic } from "./onboarding-client";

/**
 * /admin/onboarding — WhatsApp Embedded Signup（App Review §2，ADMIN-only）。
 *
 * 流程：FB SDK login（config_id）→ code → /api/admin/onboarding/exchange →
 * phone number register + WABA subscribe + 寫入 clinic.waPhoneNumberId + 審計。
 * 實測日 FB Dashboard 預前置（App Review MD §2.1）必須先完成。
 *
 * ★ 必要介面 touch（2026-08-20）：(admin)/admin/layout.tsx 嘅 STAFF 分支由
 *   redirect("/inbox") 改做 forbidden()（403）— 因為 App Review 驗收要求
 *   「onboarding/templates 非 ADMIN 403」，而 layout 會先於 page 執行，
 *   redirect 會令 403 永遠唔見到。對齊 admin API 層嘅 fail-closed 403 語義。
 *   unauthenticated 仍然 redirect(/login)（登入 UX，保持不變）。
 */
export default async function OnboardingPage() {
  const session = await getServerSession();
  if (!session) unauthorized(); // 防線二：layout 已把 unauth 導去 /login，呢度係防 layout 改動
  if (session.role !== "ADMIN") forbidden(); // 非 ADMIN → 403（App Review 驗收）

  const clinics = await prisma.clinic.findMany({
    select: { id: true, code: true, name: true, waPhoneNumberId: true },
    orderBy: { code: "asc" },
  });

  const items: OnboardingClinic[] = clinics.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    waPhoneNumberId: c.waPhoneNumberId,
  }));

  return <OnboardingClient clinics={items} />;
}
