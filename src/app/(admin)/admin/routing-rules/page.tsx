import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import RoutingRulesAdmin from "./routing-rules-admin-client";

/** /admin/routing-rules — 路由規則管理（ADMIN-only；★ cwi-routing-20260906 MD §4.2）。 */
export const metadata = { title: "路由規則 — WA Clinic Inbox" };

export default async function RoutingRulesPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <RoutingRulesAdmin />;
}
