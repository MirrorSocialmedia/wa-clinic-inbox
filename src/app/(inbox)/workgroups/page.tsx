import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import { resolveSessionScope } from "@/lib/rbac";
import WorkgroupsClient from "@/components/workgroups/workgroups-client";

/**
 * /workgroups — ★ cwi-workgroup-20261104：工作群（inbox 內部團隊群組，唔經 WhatsApp）。
 * 全部員工見到自己係成員嘅群；集團管理員（老闆）多一個「管理群組」（開群／改名／加刪人／封存）。
 * ?g=<groupId> 直接開嗰個群（push 通知撳入嚟）；?tab=external = 外部對話分頁（Lab／供應商）。
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "工作群 — WA Clinic Inbox" };

export default async function WorkgroupsPage({ searchParams }: { searchParams: Promise<{ g?: string; tab?: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const { scopeType } = await resolveSessionScope(session);
  const sp = await searchParams;
  const g = typeof sp.g === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sp.g) ? sp.g : null;
  return (
    <WorkgroupsClient
      meId={session.staffId}
      canManage={session.role === "ADMIN" && scopeType === "ALL"}
      initialGroupId={g}
      initialTab={sp.tab === "external" ? "external" : "groups"}
    />
  );
}
