import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import WorkflowsAdmin from "./workflows-admin-client";

/** /admin/workflows — workflow 參數化 builder v1（ADMIN-only，Phase D）。 */
export const metadata = { title: "Workflow 參數 — WA Clinic Inbox" };

export default async function WorkflowsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <WorkflowsAdmin />;
}
