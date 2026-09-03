import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import GoldenAdmin from "./golden-admin-client";

/** /admin/golden — ★ Part F（cwi-raggolden-20260904，F.5/F.6）GoldenCase 評測集管理（ADMIN-only）。 */
export const metadata = { title: "GoldenCase 評測 — WA Clinic Inbox" };

export default async function GoldenPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <GoldenAdmin />;
}
