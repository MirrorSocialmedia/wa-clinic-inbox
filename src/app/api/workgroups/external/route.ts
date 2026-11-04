/**
 * ★ cwi-workgroup-p2-20261105：GET /api/workgroups/external — 「外部對話」列表（Lab／供應商；最近先，最多 200）。
 * 範圍同收件箱一樣（店集合 ∪ 我負責；全店管理員 = 全部）。撳入去 = /inbox?conv=<id>（照用收件箱嘅對話畫面覆）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { listExternalConversations } from "@/lib/external-contacts";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  return NextResponse.json({ items: await listExternalConversations(auth) });
});
