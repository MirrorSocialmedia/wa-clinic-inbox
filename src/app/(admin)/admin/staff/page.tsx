import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import StaffAdmin from "./staff-admin-client";

/** /admin/staff — 員工 CRUD（ADMIN-only）。 */
export const metadata = { title: "員工管理 — WA Clinic Inbox" };

export default async function StaffPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <StaffAdmin />;
}
