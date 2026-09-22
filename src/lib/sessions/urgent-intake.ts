import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getLexicon, applyLexicon } from "@/lib/sessions/lexicon";
import { getParams } from "@/lib/workflow/store";
import { matchRedFlagTerms } from "@/lib/sessions/red-flags";
import { publishConvEvent } from "@/lib/notify";
import { pushEvent } from "@/lib/push";

/**
 * ★ cwi-final S1-14：deterministic 紅旗 — inbound 落庫後即行（唔等 LLM、唔等 AI queue）。
 * 冪等：urgent 已 true 唔重推；StaffNotice 按 msgId 查重。回 true = 命中。
 */
export async function urgentIntake(a: {
  clinicId: string; convId: string; msgId: string; wamid: string | null; body: string | null; type: string;
}): Promise<boolean> {
  if (a.type !== "text" || !a.body) return false;
  const lex = await getLexicon(a.clinicId);
  const params = await getParams("pain-triage", a.clinicId);
  const rf = matchRedFlagTerms([applyLexicon(a.body, lex)], params);
  if (!rf.hit) return false;

  const upd = await prisma.conversation.updateMany({
    where: { id: a.convId, urgent: false },
    data: { urgent: true, urgency: "HIGH", intent: "URGENT_PAIN" },
  });
  const dup = await prisma.staffNotice.findFirst({
    where: { conversationId: a.convId, kind: "URGENT_ESCALATION", meta: { path: ["msgId"], equals: a.msgId } },
    select: { id: true },
  });
  if (!dup) {
    await prisma.staffNotice.create({
      data: {
        clinicId: a.clinicId, conversationId: a.convId, kind: "URGENT_ESCALATION",
        title: "急症升級 — 紅旗詞（系統即時判斷）",
        meta: { msgId: a.msgId, wamid: a.wamid, categories: rf.categories, source: "intake" },
      },
    });
  }
  if (upd.count === 1) {
    const conv = await prisma.conversation.findUnique({ where: { id: a.convId }, select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true, contactId: true } });
    if (conv) {
      await publishConvEvent(conv, "urgent:escalation", { conversationId: conv.id, clinicId: conv.clinicId, intent: "URGENT_PAIN", urgency: "HIGH", contactId: conv.contactId, waMessageId: a.wamid });
      pushEvent({ kind: "urgent", clinicId: conv.clinicId, conversationId: conv.id });
    }
    log.info({ convId: a.convId, categories: rf.categories }, "urgent-intake: red flag → urgent");
  }
  return true;
}
