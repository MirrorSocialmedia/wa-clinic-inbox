import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import ClinicalTerms from "./clinical-terms-client";

/**
 * /admin/clinical-terms — cwi-followup-p4-20260916 S6：術語對照表（MD §5.3）。
 * 醫生／護士可編輯：「速記 → 標準名稱 · 用喺」；解析規則本身（牙位／金額／意向詞）唔可編輯。
 * 任意活躍 staff 可入（日常臨床工具）；layout fail-closed + route 防線二。
 */
export const metadata = { title: "術語對照表 — WA Clinic Inbox" };

export default async function ClinicalTermsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  return <ClinicalTerms />;
}
