import { redirect } from "next/navigation";

/**
 * /admin/quotes — cwi-setnav SET-03：已搬去 /quotes（收件箱殼 — 前線 staff 日常用）。
 * 呢度只留 redirect（舊書籤／舊連結照用）。
 */
export const metadata = { title: "報價確認 — WA Clinic Inbox" };

export default function AdminQuotesRedirectPage() {
  redirect("/quotes");
}
