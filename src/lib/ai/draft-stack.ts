import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { publishConvEvent } from "@/lib/notify";

/** ★ cwi-final S1-13（D-6）：同一對話最多保留幾多個 PROPOSED */
export const DRAFT_STACK_MAX = 3;

/** 新草稿建立**成功之後** call。回傳被擠出嘅 id。失敗唔 throw（下次建立會再收窄）。 */
export async function capDraftStack(conversationId: string): Promise<string[]> {
  try {
    const expired = await prisma.$transaction(async (tx) => {
      // pg_advisory_xact_lock 回 void — Prisma $queryRaw 讀唔到 void column，要用 $executeRaw
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"draftstack:" + conversationId}))`;
      const rows = await tx.aiDraft.findMany({
        where: { conversationId, status: "PROPOSED" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const ids = rows.slice(DRAFT_STACK_MAX).map((r) => r.id);
      if (ids.length) await tx.aiDraft.updateMany({ where: { id: { in: ids }, status: "PROPOSED" }, data: { status: "EXPIRED" } });
      return ids;
    });
    if (expired.length) {
      const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true } });
      if (conv) await publishConvEvent(conv, "draft:expired", { conversationId, clinicId: conv.clinicId, draftIds: expired });
      log.info({ conversationId, expired: expired.length }, "draft-stack: oldest PROPOSED → EXPIRED");
    }
    return expired;
  } catch (err) {
    log.warn({ conversationId, err: err instanceof Error ? err.message : String(err) }, "draft-stack: cap failed（下次建立再收窄）");
    return [];
  }
}
