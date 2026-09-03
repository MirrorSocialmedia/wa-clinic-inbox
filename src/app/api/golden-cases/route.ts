/**
 * ★ Part F（cwi-raggolden-20260904，F.5）：GoldenCase API。
 *
 * GET  /api/golden-cases?clinicId=&source=&enabled= — 列表（STAFF = 綁定店 scope；ADMIN 全店）
 * POST /api/golden-cases — **STAFF 可加**（inbox「加入測試集」彈窗）— 入庫前強制 deid（第二層兜底）
 * PUT  /api/golden-cases/[id] — ADMIN-only（編輯/啟用停用）
 * DELETE /api/golden-cases/[id] — ADMIN-only（審核「✗ 丟」/ 清理）
 * GET  /api/golden-cases/prefill?messageId= — inbox hover 彈窗預填：server-side deid
 *      （contactName + profileName）+ AI 當時判斷（AiDraft intent 快照 → conversation.intent fallback）
 *
 * 零 PII 鐵律：GoldenCase 無 conversationId/messageId 欄（結構層）；utterance/contextBefore
 * 入庫前 deid（src/lib/golden/deid.ts — 電話→<phone>、姓名→<name>、日期/金額保留）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, clinicScope } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { deid, deidList } from "@/lib/golden/deid";
import { createGoldenSchema, updateGoldenSchema } from "@/lib/golden/schemas";
import log from "@/lib/log";

export const dynamic = "force-dynamic";


export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const source = req.nextUrl.searchParams.get("source");
  const enabled = req.nextUrl.searchParams.get("enabled");
  const clinicParam = req.nextUrl.searchParams.get("clinicId");
  const scope = clinicScope(ctx);
  // clinicParam 過濾（admin UI 頂部店選單）— STAFF 仍限綁定店交集（fail-closed）
  const clinicWhere = clinicParam
    ? scope.clinicId
      ? scope.clinicId.in.includes(clinicParam)
        ? { clinicId: clinicParam }
        : { clinicId: { in: [] } } // 唔喺 scope → 零結果（唔好 500）
      : { clinicId: clinicParam }
    : scope;
  const rows = await prisma.goldenCase.findMany({
    where: {
      ...clinicWhere,
      ...(source ? { source: source as "INBOX_BUTTON" | "HISTORY_SAMPLE" | "MANUAL" } : {}),
      ...(enabled !== null ? { enabled: enabled === "true" } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return NextResponse.json({
    cases: rows.map((r) => ({
      id: r.id,
      clinicId: r.clinicId,
      source: r.source,
      utterance: r.utterance,
      contextBefore: r.contextBefore,
      expectIntent: r.expectIntent,
      expectRedFlag: r.expectRedFlag,
      expectAutoOk: r.expectAutoOk,
      expectDocIds: r.expectDocIds,
      note: r.note,
      enabled: r.enabled,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
    })),
  });
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req); // STAFF 可加（MD F.5）
  const body = await req.json().catch(() => null);
  const parsed = createGoldenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;
  // clinic 權限：STAFF 只可加綁定店
  const scope = clinicScope(ctx);
  if (scope.clinicId && !scope.clinicId.in.includes(d.clinicId)) {
    return NextResponse.json({ error: "clinic not in scope" }, { status: 403 });
  }
  // 第二層 deid 兜底（prefill 已 deid；這裡再過電話規則 — names 唔會重複需要）
  const utterance = deid(d.utterance);
  const contextBefore = deidList(d.contextBefore).slice(0, 2);
  const gc = await prisma.goldenCase.create({
    data: {
      clinicId: d.clinicId,
      source: "INBOX_BUTTON",
      utterance,
      contextBefore,
      expectIntent: d.expectIntent,
      expectRedFlag: d.expectRedFlag,
      expectAutoOk: d.expectAutoOk,
      expectDocIds: d.expectDocIds,
      note: d.note ?? null,
      enabled: true, // inbox 掣 = staff 即時確認過判斷 → 可直接入 eval
      createdBy: ctx.staff.id,
    },
  });
  log.info({ staffId: ctx.staff.id, goldenCaseId: gc.id }, "golden: created from inbox button");
  return NextResponse.json({ id: gc.id }, { status: 201 });
});
// prefill 喺獨立路由：/api/golden-cases/prefill（route handler 名只認 HTTP method）
