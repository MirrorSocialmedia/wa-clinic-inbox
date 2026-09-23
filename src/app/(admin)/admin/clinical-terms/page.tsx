import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import { resolveSessionScope } from "@/lib/rbac";
import ClinicalTerms from "./clinical-terms-client";

/**
 * /admin/clinical-terms — cwi-followup-p4-20260916 S6：術語對照表（MD §5.3）。
 * 讀：全部員工（報價卡／跟進要顯示標準名）；改：只限全集團 ADMIN（★ cwi-final S3-4（D-5））。
 * layout fail-closed + route 防線二（requireGlobalAdmin）。
 */
export const metadata = { title: "術語對照表 — WA Clinic Inbox" };

export default async function ClinicalTermsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const { scopeType } = await resolveSessionScope(session);
  const canEdit = session.role === "ADMIN" && scopeType === "ALL";
  return <ClinicalTerms canEdit={canEdit} />;
}
