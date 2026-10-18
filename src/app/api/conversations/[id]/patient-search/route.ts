import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hit } from "@/lib/rate-limit";
import { searchPatientsByKeyword, WorkforceApiError } from "@/lib/workforce/client";
import { rememberSearchHits } from "@/lib/patient-links";

/**
 * GET /api/conversations/[id]/patient-search?q= — 搜病人（編號／姓名／電話；全部 Apricot 帳號）
 * ★ cwi-multi-patient-20261018：「病人」卡〔＋ 加入病人〕用。結果記喺 server（15 分鐘）— 加入時核對，唔信 client。
 *
 * 權限：對話可寫嘅 staff（所有員工 — 擁有人拍板）；每人每分鐘 20 次。
 * 🔴 q 可能係電話／姓名 → 唔入 log／audit（只記長度同筆數）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  assertCanWriteConversation(auth);

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 50) return NextResponse.json({ error: "請輸入 2–50 個字" }, { status: 400 });
  if (!(await hit(`psearch:${auth.staff.id}`, 20, 60))) {
    return NextResponse.json({ error: "搜尋太密，請一分鐘後再試" }, { status: 429 });
  }

  let r;
  try {
    r = await searchPatientsByKeyword(q, auth.staff.id);
  } catch (e) {
    log.warn(
      { conversationId: conv.id, err: e instanceof WorkforceApiError ? `status=${e.status}` : e instanceof Error ? e.name : "unknown" },
      "patient-search: workforce failed"
    );
    return NextResponse.json({ error: "暫時搜唔到（workforce／Apricot 未接通）— 稍後重試" }, { status: 502 });
  }

  await rememberSearchHits(auth.staff.id, conv.contactId, r.patients);
  const linked = new Set(
    (await prisma.contactPatientLink.findMany({ where: { contactId: conv.contactId }, select: { patientApricotId: true } })).map((l) => l.patientApricotId)
  );
  await prisma.auditLog
    .create({
      data: { staffId: auth.staff.id, action: "PATIENT_SEARCH", entity: "Conversation", entityId: conv.id, meta: { qLen: q.length, count: r.patients.length } },
    })
    .catch(() => undefined);

  return NextResponse.json({
    patients: r.patients.map((p) => ({ ...p, linked: linked.has(p.patientApricotId) })),
    sources: r.sources.map((s) => ({ label: s.label, ok: s.ok })),
  });
});
