import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import AutomationAdmin from "./automation-admin-client";

/** /admin/automation — 成熟度儀表板 + 級別開關（ADMIN-only，Phase E）。 */
export const metadata = { title: "AI 自動化級別 — WA Clinic Inbox" };

export default async function AutomationPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <AutomationAdmin />;
}
