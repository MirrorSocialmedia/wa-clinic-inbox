import { unauthorized, forbidden } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import FollowupsClient from "./followups-client";

/**
 * /admin/followups — 跟進規則（followup-v3 MD §0/§2，ADMIN-only）。
 *
 * ★ cwi-followup-v3：形態 = 員工提示層（cron 零 outbound；只建 SUGGESTED 建議）。
 *   獨立「待跟進隊列」頁 ❌ 已取消 → 收件箱「待跟進 N」膠囊 + 對話內建議卡。
 * 兩區（client 拉 API）：
 * ① 規則（啟用/延遲/dedupWindowDays/上輪 scan 健康；B1 首啟用確認彈窗）
 * ② Template registry（5 條中文 draft 出廠 approved=false — 老細審批；
 *    未審批 + 窗口過咗 → 建議卡顯示「等 template 審批」唔俾發）
 */
export const dynamic = "force-dynamic";

export default async function FollowupsPage() {
  const session = await getServerSession();
  if (!session) unauthorized(); // 防線二：layout 已把 unauth 導去 /login
  if (session.role !== "ADMIN") forbidden();
  return <FollowupsClient />;
}
