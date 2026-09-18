import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import Quotes from "./quotes-client";

/**
 * /admin/quotes — cwi-followup-p4-20260916 S6：報價確認隊列（MD §5.3/S3）。
 * CWM 抽到嘅報價項目 → ✓ 收貨 / ✎ 改 / ✗ 丟；收貨可順手教字典（teachTerm）。
 * 任意活躍 staff 可入（日常臨床操作）；layout fail-closed + route 防線二。
 */
export const metadata = { title: "報價確認 — WA Clinic Inbox" };

export default async function QuotesPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  // ★ cwi-final S0-7（D-5）：全局術語字典只限全集團 ADMIN（ADMIN + scopeType ALL）—
  //   非全集團 ADMIN 隱藏「順手教字典」勾選（server 端 teachTerm 都會被撳掉，雙重防線）。
  const canTeach = session.role === "ADMIN" && session.scopeType === "ALL";
  return <Quotes canTeach={canTeach} />;
}
