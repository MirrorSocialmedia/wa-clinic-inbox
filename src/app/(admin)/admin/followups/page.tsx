import { unauthorized, forbidden } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import FollowupsClient from "./followups-client";

/**
 * /admin/followups — 主動跟進（followup-v2 MD §4，ADMIN-only）。
 *
 * 三區（client 拉 API）：
 * ① 待跟進隊列（L1 task：人撳發送 = AI_ADOPTED；發送前取消檢查重跑；唔 claim）
 * ② 規則（7 trigger；出廠 A/B×2/F 四條 enabled — C/D/E P4）
 * ③ Template registry（6 條中文 draft 出廠 approved=false — 老細審批；
 *    未審批 + 窗口過咗 → SKIPPED(NO_TEMPLATE) 唔真發）
 */
export const dynamic = "force-dynamic";

export default async function FollowupsPage() {
  const session = await getServerSession();
  if (!session) unauthorized(); // 防線二：layout 已把 unauth 導去 /login
  if (session.role !== "ADMIN") forbidden();
  return <FollowupsClient />;
}
