import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import SuggestionsAdmin from "./suggestions-admin-client";

/** /admin/suggestions — 學習迴路 review queue（ADMIN-only，Phase E）。 */
export const metadata = { title: "AI 建議 — WA Clinic Inbox" };

export default async function SuggestionsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <SuggestionsAdmin />;
}
