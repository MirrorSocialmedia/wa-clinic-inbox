import { unauthorized, forbidden } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import SalesAdminClient from "./sales-admin-client";

/**
 * /admin/sales — 銷售系統（cwi-sales-20261028，ADMIN-only；寫入只限集團管理員）。
 * 三個分頁：規則設定（保護期／上限／通知／意向名稱）｜傭金項目（逐間店 + 立即更新名單）｜病人歸屬（指派／轉移／放返公海）。
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "銷售 — WA Clinic Inbox" };

export default async function SalesAdminPage() {
  const session = await getServerSession();
  if (!session) unauthorized();
  if (session.role !== "ADMIN") forbidden();
  return <SalesAdminClient />;
}
