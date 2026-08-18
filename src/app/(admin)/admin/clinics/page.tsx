import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import ClinicsAdmin from "./clinics-admin-client";

/** /admin/clinics — 診所 CRUD（ADMIN-only）。 */
export const metadata = { title: "診所管理 — WA Clinic Inbox" };

export default async function ClinicsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <ClinicsAdmin />;
}
