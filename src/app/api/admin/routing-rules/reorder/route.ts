import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * /api/admin/routing-rules/reorder — ★ cwi-routing-20260906（MD §4.2）：拖拉改次序（ADMIN-only）。
 *
 * POST { clinicId: string|null, orderedIds: string[] }
 *   orderedIds = 該店域（clinicId）規則由上至下 — server 驗「必須 = 該域全部規則 id」先落
 *   priority = (i+1)*10（engine 每次匹配都查 DB → 改完即時生效，無 cache 要 bust）。
 */
export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const clinicId = raw.clinicId === null || typeof raw.clinicId === "string" ? (raw.clinicId as string | null) : null;
  const orderedIds = Array.isArray(raw.orderedIds) ? raw.orderedIds : null;
  if (!orderedIds || !orderedIds.every((x) => typeof x === "string") || orderedIds.length < 2) {
    return NextResponse.json({ error: "bad_request", message: "body: { clinicId: string|null, orderedIds: string[] (≥2) }" }, { status: 400 });
  }
  if (new Set(orderedIds as string[]).size !== orderedIds.length) {
    return NextResponse.json({ error: "bad_request", message: "orderedIds has duplicates" }, { status: 400 });
  }

  // 同域全部規則 id 必須 = orderedIds（防跨域攪亂優先級）
  const domain = await prisma.routingRule.findMany({
    where: { clinicId },
    select: { id: true, priority: true },
  });
  const domainIds = new Set(domain.map((r) => r.id));
  const orderedSet = new Set(orderedIds as string[]);
  if (domain.length !== orderedIds.length || ![...orderedSet].every((id) => domainIds.has(id))) {
    return NextResponse.json({ error: "bad_request", message: "orderedIds must equal the full rule set of this clinic scope" }, { status: 400 });
  }

  // 冇实际变动（順序同 priority 已一致）→ 200 no-op
  const unchanged = domain
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .every((r, i) => r.id === (orderedIds as string[])[i]);
  if (unchanged) return NextResponse.json({ ok: true, changed: false });

  await prisma.$transaction(
    (orderedIds as string[]).map((id, i) =>
      prisma.routingRule.update({ where: { id }, data: { priority: (i + 1) * 10 } })
    )
  );

  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "ROUTING_RULES_REORDERED",
        entity: "RoutingRule",
        entityId: null,
        meta: { clinicId, order: orderedIds } as import("@prisma/client").Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return NextResponse.json({ ok: true, changed: true });
});
