import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import SuggestionsAdmin from "./suggestions-admin-client";

/** /admin/suggestions — 學習迴路 review queue（ADMIN-only，Phase E）。 */
export const metadata = { title: "AI 建議 — WA Clinic Inbox" };

export default async function SuggestionsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  // ★ cwi-routing-20260906 §8：SUPERVISOR 讀寫（AI 級別 / AI 建議）
  if (session.role !== "ADMIN" && session.role !== "SUPERVISOR") redirect("/inbox");
  return <SuggestionsAdmin />;
}
