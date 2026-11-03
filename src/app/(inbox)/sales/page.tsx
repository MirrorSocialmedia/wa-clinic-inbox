import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { getServerSession } from "@/lib/session-server";
import SalesMineClient from "./sales-mine-client";

/**
 * /sales — 我的銷售（cwi-sales 第 3 期）：本月傭金、保護中／綁定數、我開嘅單（已收／總額／傭金）、分類帳明細。
 * 只限銷售人員（唔係 → 返收件箱）；只見自己（API 用 session staffId，唔收 query）。
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "我的銷售 — WA Clinic Inbox" };

export default async function SalesMinePage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const me = await prisma.staffUser.findUnique({ where: { id: session.staffId }, select: { isSales: true } });
  if (!me?.isSales) redirect("/inbox");
  return <SalesMineClient />;
}
