import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import KnowledgeAdmin from "./knowledge-admin-client";

/** /admin/knowledge — ★ Part F（cwi-raggolden-20260904，F.2）知識庫管理（ADMIN-only）。 */
export const metadata = { title: "知識庫 — WA Clinic Inbox" };

export default async function KnowledgePage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <KnowledgeAdmin />;
}
