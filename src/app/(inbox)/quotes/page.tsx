import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import { sessionScopeType } from "@/lib/rbac";
import Quotes from "@/app/(admin)/admin/quotes/quotes-client";

/**
 * /quotes — 報價確認（cwi-setnav SET-03：搬出 /admin 入收件箱殼 — NavRail + BottomTabBar）。
 *
 * 權限（工單 SET-03）：
 * - STAFF／ADMIN 可操作（✓／✎／✗ 掣）
 * - SUPERVISOR 唯讀（write API 已有 assertCanWriteConversation 守 — UI 掣照 show，
 *   server 403 兜底；入得 = 所有 active staff，同 (inbox) layout 口徑）
 * - 範圍跟 scopedClinicSet（API 已有）
 * - canTeach（順手教字典）= 全集團 ADMIN（ALL scope）— 照舊
 *
 * 舊入口 /admin/quotes → redirect("/quotes")（舊書籤照用）。
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "報價確認 — WA Clinic Inbox" };

export default async function QuotesInboxPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const canTeach = session.role === "ADMIN" && sessionScopeType(session) === "ALL";
  return <Quotes canTeach={canTeach} />;
}
