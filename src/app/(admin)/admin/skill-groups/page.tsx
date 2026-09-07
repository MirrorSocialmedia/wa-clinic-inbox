import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import SkillGroupsAdmin from "./skill-groups-admin-client";

/** /admin/skill-groups — 技能組管理（ADMIN-only；★ cwi-routing-20260906 MD §4.1）。 */
export const metadata = { title: "技能組 — WA Clinic Inbox" };

export default async function SkillGroupsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <SkillGroupsAdmin />;
}
