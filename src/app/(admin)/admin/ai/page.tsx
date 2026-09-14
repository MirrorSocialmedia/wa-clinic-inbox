import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import AiHub from "./ai-hub-client";

/**
 * /admin/ai — ★ cwi-hub-b-20260914（Part B B.2）：AI 流程 hub。
 * 頂部系統健康列（紅底先顯示）→ 上半沙盤（零副作用，ADMIN 可操）→ 下半七步狀態列（即時算）。
 * SUPERVISOR 可讀（hub 摘要唯讀）；沙盤輸入區 ADMIN-only（SUPERVISOR 隱藏 — run API 403 背墊）。
 */
export const metadata = { title: "AI 流程 — WA Clinic Inbox" };

export default async function AiHubPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN" && session.role !== "SUPERVISOR") redirect("/inbox");
  return <AiHub role={session.role} />;
}
