import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { FollowupStatus } from "@prisma/client";
import { renderFollowupText } from "@/lib/followup/engine";

/**
 * ★ cwi-followup-v3-20260916：follow-up 建議列表（staff+，clinic scope）。
 *
 * GET /api/followups/tasks?status=SUGGESTED&limit=100[&conversationId=X]
 *   → { tasks: [{ id, clinicId, ruleName, trigger, dueAt, status, templateName,
 *                 templateApproved, templateLanguage, templatePreview,
 *                 patientName, salutation, optOut, contextJson, templateVars, cancelReason, createdAt, conversationId }] }
 *   預設 = SUGGESTED 按 dueAt asc（最急先）；patientName = 顯示用（對話既有資料）。
 *   零臨床全文：contextJson/templateVars 只係顯示用結構化數據。
 */
export const dynamic = "force-dynamic";

const STATUSES = new Set<string>(["SUGGESTED", "SENT", "SKIPPED", "CANCELLED", "COMPLETED", "EXPIRED"]);

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? undefined;
  if (status && !STATUSES.has(status)) return NextResponse.json({ error: "bad status" }, { status: 400 });
  const limit = Math.min(Number(sp.get("limit") ?? 100) || 100, 200);
  const conversationId = sp.get("conversationId") ?? undefined;
  const clinicSet = scopedClinicSet(ctx);

  const tasks = await prisma.followupTask.findMany({
    where: {
      ...(status ? { status: status as FollowupStatus } : { status: "SUGGESTED" }),
      ...(clinicSet ? { clinicId: { in: clinicSet } } : {}),
      ...(conversationId ? { conversationId } : {}),
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
    ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, profileName: true, salutation: true, followupOptOut: true, locale: true } })
    : [];
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  // ★ cwi-followup-v3：template 預覽（對話內建議卡用）— 只讀 storedTemplate，{{var}} 已填；
  //   零模板（無 templateName）→ preview null。缺變數 = 空字串（renderFollowupText 口徑）。
  //   ★ B-9：Contact.locale === "en" 且 `<key>_en` 存在 → 預覽用 _en 版本（同 engine send 同一口徑）。
  const baseKeys = [...new Set(tasks.map((t) => t.templateName).filter(Boolean))] as string[];
  const tKeys = new Set<string>(baseKeys);
  for (const t of tasks) {
    if (!t.templateName) continue;
    const cv = t.conversationId ? convs.find((c) => c.id === t.conversationId) : null;
    const ct = cv ? contactMap.get(cv.contactId) : null;
    if (ct?.locale === "en") tKeys.add(`${t.templateName}_en`);
  }
  const templateRows = tKeys.size
    ? await prisma.followupTemplate.findMany({ where: { key: { in: [...tKeys] } }, select: { key: true, approved: true, language: true, text: true } })
    : [];
  const tMap = new Map(templateRows.map((t) => [t.key, t]));
  const resolveTpl = (t: { templateName: string | null }, ct: { locale: string | null } | null | undefined) => {
    if (!t.templateName) return undefined;
    if (ct?.locale === "en") {
      const en = tMap.get(`${t.templateName}_en`);
      if (en) return en;
    }
    return tMap.get(t.templateName);
  };

  return NextResponse.json({
    tasks: tasks.map((t) => {
      const cv = t.conversationId ? convs.find((c) => c.id === t.conversationId) : null;
      const ct = cv ? contactMap.get(cv.contactId) : null;
      const rule = t.ruleId ? ruleMap.get(t.ruleId) : null;
      const tpl = resolveTpl(t, ct);
      const vars = (t.templateVars as Record<string, string | number | null | undefined> | null) ?? {};
      return {
        id: t.id,
        clinicId: t.clinicId,
        conversationId: t.conversationId,
        ruleName: rule?.name ?? null,
        trigger: rule?.trigger ?? null,
        templateName: t.templateName,
        templateApproved: tpl ? tpl.approved : t.templateName ? false : null,
        templateLanguage: tpl?.language ?? "zh_HK",
        // ★ 對話內建議卡：已填變數預覽（窗口內 = composer 草稿底稿；過窗 = 只可發呢段）
        templatePreview: tpl && t.templateName ? renderFollowupText(tpl.text, vars) : null,
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
