import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import ConsultSettingsAdmin from "@/components/admin/consult-settings-admin";

/**
 * ★ consult v2.1 C5（MD §8.1）：設定 → 「AI 傾偈設定」（新入口，唔叫 Workflow/CONSULT）。
 * 三 tab：方案資料 ｜ AI 會點傾 ｜ 進階（細字入口，ADMIN 先見到）。
 * ADMIN + SUPERVISOR 入到（layout 口徑）；Tab 3 + 寫入 API 只 ADMIN（requireAdmin）。
 */
export const metadata = { title: "AI 傾偈設定 — WA Clinic Inbox" };

export default async function ConsultSettingsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN" && session.role !== "SUPERVISOR") redirect("/inbox");
  return <ConsultSettingsAdmin role={session.role} />;
}
