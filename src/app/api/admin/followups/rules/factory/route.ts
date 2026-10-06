import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { FOLLOWUP_FACTORY_TEMPLATES, FOLLOWUP_FACTORY_RULES } from "@/lib/followup/factory-defaults";

/**
 * ★ cwi-setfix F-1：POST /api/admin/followups/rules/factory — 「建立出廠規則」（global admin）。
 *
 * 背景：規則／template 以前只由 db:seed + seed-followup-p4 建；生產 DB 唔行 seed（會建 mock 診所／帳號）
 *   → 「跟進規則」頁空白冇嘢改。呢個 endpoint 用同一份出廠清單（src/lib/followup/factory-defaults.ts）補缺：
 *   - template：key 唔存在先建（approved=false — 照審批流）；已存在唔郁（審批／改字唔會洗走）
 *   - 規則：全局（clinicId null）同 trigger + templateName 唔存在先建；**一律 enabled=false**
 *     （管理員逐條睇完先開；BEFORE_APPOINTMENT 開嗰陣照行首啟用確認）
 * 冪等：重撳只會補返被刪走嘅項目。→ { templatesCreated, rulesCreated, rulesSkipped }
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireGlobalAdmin(req);
  let templatesCreated = 0;
  let rulesCreated = 0;
  let rulesSkipped = 0;
  for (const t of FOLLOWUP_FACTORY_TEMPLATES) {
    const existing = await prisma.followupTemplate.findUnique({ where: { key: t.key }, select: { key: true } });
    if (existing) continue;
    await prisma.followupTemplate.create({ data: { key: t.key, name: t.name, text: t.text, language: "zh_HK", approved: false } });
    templatesCreated++;
  }
  for (const r of FOLLOWUP_FACTORY_RULES) {
    const existing = await prisma.followupRule.findFirst({
      where: { clinicId: null, trigger: r.trigger as never, templateName: r.templateName },
      select: { id: true },
    });
    if (existing) {
      rulesSkipped++;
      continue;
    }
    await prisma.followupRule.create({
      data: {
        clinicId: null,
        name: r.name,
        enabled: false,
        trigger: r.trigger as never,
        delayValue: r.delayValue,
        delayUnit: r.delayUnit as never,
        reasonCodes: r.reasonCodes,
        templateName: r.templateName,
        level: "L1",
        maxSends: 1,
        createdBy: ctx.staff.id,
      },
    });
    rulesCreated++;
  }
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "FOLLOWUP_FACTORY_INSTALLED",
      entity: "FollowupRule",
      entityId: "factory",
      meta: { templatesCreated, rulesCreated, rulesSkipped } as object,
    },
  });
  return NextResponse.json({ templatesCreated, rulesCreated, rulesSkipped });
});
