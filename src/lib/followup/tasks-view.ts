import prisma from "@/lib/prisma";
import { FollowupStatus } from "@prisma/client";
import { renderFollowupText } from "@/lib/followup/engine";
import { approvedTemplateList } from "@/lib/wa/approved-templates";

/**
 * ★ cwi-final S6-7：follow-up 建議 task view 構造（單一來源）。
 *
 * 由 GET /api/followups/tasks 抽出 — 同 GET /api/conversations/[id]/bundle（開對話一次
 * round trip 合併拉）共用，防兩處 mapping 漂移。口徑 = 原 route 逐字（S2-5 Meta 審批 /
 * B-9 _en 版本 / 預覽 renderFollowupText）。
 */
export interface FollowupTaskViewOpts {
  /** 狀態 filter（route 已驗證；省 = SUGGESTED） */
  status?: string;
  /** 限單一對話（bundle 用） */
  conversationId?: string;
  /** clinic scope（scopedClinicSet 產物；null = 全店） */
  clinicSet: string[] | null;
  limit?: number;
}

export async function buildFollowupTaskViews(opts: FollowupTaskViewOpts): Promise<unknown[]> {
  const { status, conversationId, clinicSet, limit = 100 } = opts;
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
  // ★ cwi-final S2-5：per-clinic Meta 審批名單（全部 APPROVED；mock = 同一份；real = 每個 WABA 一 call）
  //   fail-soft：approvedTemplateList 內部 catch → []（Meta 掛 = 全部 templateMetaApproved=false — 保守唔放發）。
  const clinicIds = [...new Set(tasks.map((t) => t.clinicId).filter(Boolean))] as string[];
  const clinics = clinicIds.length
    ? await prisma.clinic.findMany({ where: { id: { in: clinicIds } }, select: { id: true, waBusinessAccountId: true } })
    : [];
  const clinicMap = new Map(clinics.map((c) => [c.id, c]));
  const metaListByWaba = new Map<string, Awaited<ReturnType<typeof approvedTemplateList>>>();
  for (const c of clinics) {
    const key = c.waBusinessAccountId ?? "__none__";
    if (!metaListByWaba.has(key)) metaListByWaba.set(key, await approvedTemplateList({ waBusinessAccountId: c.waBusinessAccountId }));
  }
  const metaForClinic = (clinicId: string | null) => {
    if (!clinicId) return [];
    const c = clinicMap.get(clinicId);
    return c ? metaListByWaba.get(c.waBusinessAccountId ?? "__none__") ?? [] : [];
  };
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
    ? await prisma.followupTemplate.findMany({ where: { key: { in: [...tKeys] } }, select: { key: true, approved: true, language: true, text: true, waTemplateName: true } })
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

  return tasks.map((t) => {
    const cv = t.conversationId ? convs.find((c) => c.id === t.conversationId) : null;
    const ct = cv ? contactMap.get(cv.contactId) : null;
    const rule = t.ruleId ? ruleMap.get(t.ruleId) : null;
    const tpl = resolveTpl(t, ct);
    const vars = (t.templateVars as Record<string, string | number | null | undefined> | null) ?? {};
    // ★ cwi-final S2-5：Meta 側審批（name = waTemplateName ?? key — 同 engine 雙 gate 同一口徑）
    const metaName = t.templateName ? tpl?.waTemplateName || t.templateName : null;
    const metaTpl = metaName ? metaForClinic(t.clinicId).find((m) => m.name === metaName) : null;
    return {
      id: t.id,
      clinicId: t.clinicId,
      conversationId: t.conversationId,
      ruleName: rule?.name ?? null,
      trigger: rule?.trigger ?? null,
      templateName: t.templateName,
      templateApproved: tpl ? tpl.approved : t.templateName ? false : null,
      templateMetaApproved: t.templateName ? !!metaTpl : null,
      templateWaCategory: metaTpl?.category ?? null,
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
  });
}
