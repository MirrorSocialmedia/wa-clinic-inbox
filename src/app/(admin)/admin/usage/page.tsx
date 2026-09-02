import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import UsageClient from "./usage-client";

/** /admin/usage — 用量統計（ADMIN-only；cwi-window-20260901 P4 / W-4）。 */
export const metadata = { title: "用量統計 — WA Clinic Inbox" };

export default async function UsagePage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");
  return <UsageClient />;
}
