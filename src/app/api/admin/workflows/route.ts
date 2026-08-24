import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { SCHEMA_HINTS, WORKFLOW_KEYS, type WorkflowKey } from "@/lib/workflow/definitions";
import { getActiveInfo } from "@/lib/workflow/store";

/**
 * GET /api/admin/workflows — ADMIN-only。
 * 每 key：生效參數（三級 fallback 解開後）+ 來源 + code defaults + schemaHints（表單驅動）。
 * ?clinicId= → 顯示該店視角（店有自己 ACTIVE → source=clinic）。
 * fail-soft：DB 死 → defaults（零 5xx）。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const clinicId = req.nextUrl.searchParams.get("clinicId"); // null/undefined = 全局視角
  const workflows = await Promise.all(
    WORKFLOW_KEYS.map(async (key: WorkflowKey) => {
      const info = await getActiveInfo(key, clinicId ?? null);
      return {
        key,
        active: {
          source: info.source,
          version: info.version,
          params: info.params,
          publishedAt: info.publishedAt,
        },
        defaults: info.defaults,
        schemaHints: SCHEMA_HINTS[key],
      };
    })
  );
  return NextResponse.json({ workflows });
});
