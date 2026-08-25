/**
 * /api/admin/automation — 成熟度儀表板 + 級別開關（Phase E，cwi-ai-20260825-t5）。
 *
 * GET   — 店 × intent 矩陣：現級 + 最近 4 完整週 stats/走勢 + eligible 徽章 + reasons。
 * PATCH — 調級：body { clinicId, category, level }
 *   - 白名單 env AUTOMATION_ADMIN_STAFF_IDS（留空 = 全部 ADMIN 可調）
 *   - URGENT_PAIN / COMPLAINT 永遠人手 → 400（鐵律；UI 亦無掣 = 雙擋）
 *   - AutomationPolicy upsert + AuditLog(SET_AUTOMATION_LEVEL {from,to}) + clearAutomationLevelCache()
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { publishControl } from "@/lib/notify";
import {
  asLevel,
  clearAutomationLevelCache,
  globalCap,
  minLevel,
  resolveLevel,
  type AutomationLevel,
} from "@/lib/ai/automation";
import { lastFourCompleteWeeks, statsForEligibilityWindow } from "@/lib/ops/automation-stats";
import { adoptRate, isEligible, type StatLike } from "@/lib/ops/eligibility";

export const dynamic = "force-dynamic";

/** 矩陣列（MD 順序）— URGENT_PAIN / COMPLAINT 永遠人手（無開關）。 */
const CATEGORIES = ["BOOKING_REQUEST", "QUESTION", "URGENT_PAIN", "COMPLAINT", "OUT_OF_SCOPE", "OTHER"] as const;
const LOCKED_CATEGORIES: readonly string[] = ["URGENT_PAIN", "COMPLAINT"];

function automationAdminIds(): string[] {
  return (process.env.AUTOMATION_ADMIN_STAFF_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);

  const weeks = lastFourCompleteWeeks();
  const [clinics, policies, stats] = await Promise.all([
    prisma.clinic.findMany({ select: { id: true, code: true, name: true, aiMode: true }, orderBy: { code: "asc" } }),
    prisma.automationPolicy.findMany({ select: { clinicId: true, category: true, level: true } }),
    statsForEligibilityWindow(),
  ]);

  const policiesByClinic = new Map<string, { category: string; level: string }[]>();
  for (const p of policies) {
    const g = policiesByClinic.get(p.clinicId) ?? [];
    g.push({ category: p.category, level: p.level });
    policiesByClinic.set(p.clinicId, g);
  }
  const statsCell = new Map<string, StatLike>(); // `${clinicId}|${category}|${weekStart}`
  for (const s of stats) statsCell.set(`${s.clinicId}|${s.category}|${s.weekStart}`, s);

  const cap = globalCap();
  const allow = automationAdminIds();
  return NextResponse.json({
    global: { maxLevel: cap, whitelistEnabled: allow.length > 0, canPatch: allow.length === 0 || allow.includes(ctx.staff.id) },
    weeks,
    categories: [...CATEGORIES],
    lockedCategories: [...LOCKED_CATEGORIES],
    clinics: clinics.map((c) => {
      const rows = policiesByClinic.get(c.id) ?? [];
      const aiMode = c.aiMode === "AUTO" ? "AUTO" : "DRAFT";
      const cells: Record<string, unknown> = {};
      for (const cat of CATEGORIES) {
        const level = minLevel(resolveLevel(rows, cat, aiMode), cap);
        const last4 = weeks.map((w) => {
          const s = statsCell.get(`${c.id}|${cat}|${w}`);
          return s ?? { weekStart: w, draftCount: 0, adoptedAsIs: 0, adoptedEdited: 0, autoSent: 0, complaints: 0, rollbacks: 0 }; // ★ Fix D（cwi-fix-20260825-f1）：StatLike 加 autoSent — fallback 零值 literal 補欄
        });
        const elig = isEligible(last4);
        cells[cat] = {
          level,
          locked: LOCKED_CATEGORIES.includes(cat),
          stats: last4,
          adoptRateTrend: last4.map((s) => adoptRate(s)),
          eligible: elig.eligible,
          reasons: elig.reasons,
        };
      }
      return { id: c.id, code: c.code, name: c.name, cells };
    }),
  });
});

const patchSchema = z.object({
  clinicId: z.string().min(1),
  category: z.string().min(1),
  level: z.enum(["L1", "L2", "L3", "L4"]),
});

export const PATCH = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = patchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "bad_request", message: "body: { clinicId, category, level: L1-L4 }" }, { status: 400 });
  }
  const { clinicId, category, level } = body.data;

  // 鐵律：URGENT_PAIN / COMPLAINT 永遠人手（API 擋 — UI 無掣 = 雙擋）
  if (LOCKED_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "locked_category", message: "URGENT_PAIN / COMPLAINT 永遠人手 — 無自動化開關" }, { status: 400 });
  }

  // 開關人白名單（D-5「Kenneth 一個人」— env 留空 = 全部 ADMIN）
  const allow = automationAdminIds();
  if (allow.length > 0 && !allow.includes(ctx.staff.id)) {
    return NextResponse.json({ error: "automation_admin_only", message: "只有指定管理員可以調級" }, { status: 403 });
  }

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) return NextResponse.json({ error: "clinic_not_found" }, { status: 404 });

  const rows = await prisma.automationPolicy.findMany({
    where: { clinicId, category: { in: [category, "*"] } },
    select: { category: true, level: true },
  });
  const from = minLevel(resolveLevel(rows, category, clinic.aiMode === "AUTO" ? "AUTO" : "DRAFT"), globalCap());
  const to = minLevel(asLevel(level) ?? "L1", globalCap());

  await prisma.automationPolicy.upsert({
    where: { clinicId_category: { clinicId, category } },
    update: { level: level as AutomationLevel, updatedBy: ctx.staff.id },
    create: { clinicId, category, level: level as AutomationLevel, updatedBy: ctx.staff.id },
  });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "SET_AUTOMATION_LEVEL",
      entity: "AutomationPolicy",
      entityId: clinicId,
      meta: { clinicId, category, from, to } as object,
    },
  });
  clearAutomationLevelCache(); // MD 個 bustLevelCache() = 現有 export
  publishControl({ cmd: "cache:bust", scope: "automation" }); // ★ Fix B（cwi-fix-20260825-f1）：worker 側即時失效（唔使等 5 分鐘 TTL）

  log.info(
    { clinicId, clinicCode: clinic.code, category, from, to, staffId: ctx.staff.id },
    "automation: level changed"
  );
  return NextResponse.json({ ok: true, level: to, from, capped: to !== level });
});
