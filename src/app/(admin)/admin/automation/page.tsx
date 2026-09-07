import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import AutomationAdmin from "./automation-admin-client";

/** /admin/automation — 成熟度儀表板 + 級別開關（ADMIN-only，Phase E）。 */
export const metadata = { title: "AI 自動化級別 — WA Clinic Inbox" };

export default async function AutomationPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  // ★ cwi-routing-20260906 §8：SUPERVISOR 讀寫（AI 級別 / AI 建議）
  if (session.role !== "ADMIN" && session.role !== "SUPERVISOR") redirect("/inbox");
  return <AutomationAdmin />;
}
