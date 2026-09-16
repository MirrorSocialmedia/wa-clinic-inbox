import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { FollowupStatus } from "@prisma/client";

/**
 * ★ cwi-followup-p3-20260916（MD §4.7 驗收 #6：L1 隊列）：follow-up task 列表（staff+，clinic scope）。
 *
 * GET /api/followups/tasks?status=DUE&limit=100
 *   → { tasks: [{ id, clinicId, ruleName, trigger, level, dueAt, status, templateName,
 *                 templateApproved, patientName, salutation, optOut, contextJson, templateVars, cancelReason, createdAt }] }
 *   預設 = SCHEDULED+DUE 按 dueAt asc（最急先）；patientName = 顯示用（對話既有資料，唔係新增儲存）。
 *   零臨床全文：contextJson/templateVars 只係顯示用結構化數據（日期/金額/時間）。
 */
export const dynamic = "force-dynamic";

const STATUSES = new Set<string>(["SCHEDULED", "DUE", "SENT", "SKIPPED", "CANCELLED", "COMPLETED"]);

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? undefined;
  if (status && !STATUSES.has(status)) return NextResponse.json({ error: "bad status" }, { status: 400 });
  const limit = Math.min(Number(sp.get("limit") ?? 100) || 100, 200);
  const clinicSet = scopedClinicSet(ctx);

  const tasks = await prisma.followupTask.findMany({
    where: {
      ...(status ? { status: status as FollowupStatus } : { status: { in: ["SCHEDULED", "DUE"] as FollowupStatus[] } }),
      ...(clinicSet ? { clinicId: { in: clinicSet } } : {}),
    },
    orderBy: { dueAt: "asc" },
    take: limit,
  });
  const ruleIds = [...new Set(tasks.map((t) => t.ruleId).filter(Boolean))] as string[];
  const rules = ruleIds.length
    ? await prisma.followupRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true, trigger: true, level: true, templateName: true } })
    : [];
  const ruleMap = new Map(rules.map((r) => [r.id, r]));
  const convIds = [...new Set(tasks.map((t) => t.conversationId).filter(Boolean))] as string[];
  const convs = convIds.length
    ? await prisma.conversation.findMany({ where: { id: { in: convIds } }, select: { id: true, contactId: true } })
    : [];
  const contactIds = [...new Set(convs.map((c) => c.contactId))];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, profileName: true, salutation: true, followupOptOut: true } })
    : [];
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  const templates = await prisma.followupTemplate.findMany({ select: { key: true, approved: true } });
  const tMap = new Map(templates.map((t) => [t.key, t.approved]));

  return NextResponse.json({
    tasks: tasks.map((t) => {
      const cv = t.conversationId ? convs.find((c) => c.id === t.conversationId) : null;
      const ct = cv ? contactMap.get(cv.contactId) : null;
      const rule = t.ruleId ? ruleMap.get(t.ruleId) : null;
      return {
        id: t.id,
        clinicId: t.clinicId,
        ruleName: rule?.name ?? null,
        trigger: rule?.trigger ?? null,
        level: rule?.level ?? null,
        templateName: t.templateName,
        templateApproved: t.templateName ? (tMap.get(t.templateName) ?? false) : null,
        dueAt: t.dueAt,
        status: t.status,
        cancelReason: t.cancelReason,
        createdAt: t.createdAt,
        patientName: ct?.profileName ?? null,
        salutation: ct?.salutation ?? null,
        optOut: ct?.followupOptOut ?? false,
        // 顯示用結構化數據（零臨床全文）— UI 卡片顯示
        contextJson: t.contextJson,
        templateVars: t.templateVars,
      };
    }),
  });
});
