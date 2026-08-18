import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";

/**
 * / — 入口：已登入 → /inbox；未登入 → /login。
 * （原 create-next-app 模板頁已於 Phase 1 移除。）
 */
export default async function Home() {
  const session = await getServerSession();
  redirect(session ? "/inbox" : "/login");
}
