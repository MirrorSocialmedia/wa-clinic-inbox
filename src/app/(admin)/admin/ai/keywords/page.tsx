import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import KeywordsClient from "./keywords-client";

/**
 * /admin/ai/keywords — ★ cwi-hub-b-20260914（Part B B.4）：關鍵詞中心。
 * 四來源交叉 view（lexicon / FLOOR+附加觸發詞 / RoutingRule.keywords / KnowledgeDoc.keywords 唯讀）；
 * 改/刪口語表 → 交叉警示彈層（受影響項目）；搜尋 = 單詞版沙盤。
 * SUPERVISOR 可讀；編輯口語表 = ADMIN（workflows API 403 背墊）。
 */
export const metadata = { title: "關鍵詞中心 — WA Clinic Inbox" };

export default async function KeywordsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN" && session.role !== "SUPERVISOR") redirect("/inbox");
  return <KeywordsClient role={session.role} />;
}
