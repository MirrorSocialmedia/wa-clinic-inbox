/**
 * POST /api/admin/suggestions/[id]/decide — 建議卡人審（Phase E D-6，cwi-ai-20260825-t5）。
 *
 * body: { decision: "APPROVED" | "REJECTED", edits?: { faq?: { q, a } } }
 *
 * APPROVED 副作用（兩段式 — 批建議 ≠ 行為即刻生效）：
 * | kind          | 生效動作 |
 * | FAQ/TEMPLATE  | edits.faq 必填（冇 → 400）→ append clinic.greetingConfig.faq[]（clinicId=null → 逐店）
 * | WORKFLOW_DIFF | 調 Phase D saveDraft（出 DRAFT — **唔 publish**；Kenneth 去 /admin/workflows 發佈先生效）
 * REJECTED = 純標記，永不改任何嘢。
 *
 * 全部決定 → SuggestionCard.status/decidedBy/decidedAt + AuditLog(SUGGESTION_DECIDE, meta {kind, decision})。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { saveDraft, WorkflowError } from "@/lib/workflow/store";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  edits: z
    .object({ faq: z.object({ q: z.string().min(1), a: z.string().min(1) }) })
    .optional(),
});

export const POST = handle(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAdmin(req);
    const { id } = await params;

    const card = await prisma.suggestionCard.findUnique({ where: { id } });
    if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (card.status !== "PROPOSED") {
      return NextResponse.json({ error: "already_decided", status: card.status }, { status: 409 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "bad_request", message: "decision 必須係 APPROVED 或 REJECTED" }, { status: 400 });
    }
    const { decision, edits } = parsed.data;

    if (decision === "APPROVED") {
      if (card.kind === "FAQ" || card.kind === "TEMPLATE") {
        const faq = edits?.faq;
        if (!faq || !faq.q.trim() || !faq.a.trim()) {
          return NextResponse.json({ error: "faq_required", message: "請先填 FAQ 內容" }, { status: 400 });
        }
        // transaction：逐店 append greetingConfig.faq[]（clinicId=null → 全部店；零 cache — 下一單即用）
        const targetClinics = card.clinicId
          ? [{ id: card.clinicId }]
          : await prisma.clinic.findMany({ select: { id: true } });
        if (targetClinics.length === 0) {
          return NextResponse.json({ error: "no_clinics" }, { status: 400 });
        }
        await prisma.$transaction(async (tx) => {
          for (const c of targetClinics) {
            const row = await tx.clinic.findUnique({ where: { id: c.id } });
            if (!row) continue;
            const gc = (row.greetingConfig ?? {}) as Record<string, unknown>;
            const faqArr = Array.isArray(gc.faq) ? (gc.faq as object[]) : [];
            faqArr.push({ q: faq.q, a: faq.a });
            await tx.clinic.update({ where: { id: c.id }, data: { greetingConfig: { ...gc, faq: faqArr } as object } });
          }
        });
      } else if (card.kind === "WORKFLOW_DIFF") {
        // 兩段式：只出 DRAFT（saveDraft）— 發佈要 Kenneth 去 /admin/workflows 撳（Phase D）
        const payload = card.payload as { key?: unknown; suggestedParams?: unknown };
        if (payload.key !== "booking-session" || !payload.suggestedParams) {
          return NextResponse.json({ error: "bad_card_payload", message: "建議卡 payload 缺 key/suggestedParams" }, { status: 400 });
        }
        try {
          await saveDraft("booking-session", card.clinicId, payload.suggestedParams, ctx.staff.id);
        } catch (err) {
          if (err instanceof WorkflowError) {
            log.warn({ cardId: card.id, issues: err.issues }, "suggestions: saveDraft 參數唔合格 → 400（卡保持 PROPOSED）");
            return NextResponse.json({ error: "invalid_params", message: `建議參數唔合格：${err.message}` }, { status: 400 });
          }
          throw err;
        }
      } else {
        return NextResponse.json({ error: "unknown_kind", kind: card.kind }, { status: 400 });
      }
    }

    await prisma.suggestionCard.update({
      where: { id },
      data: { status: decision, decidedBy: ctx.staff.id, decidedAt: new Date() },
    });
    await prisma.auditLog
      .create({
        data: {
          staffId: ctx.staff.id,
          action: "SUGGESTION_DECIDE",
          entity: "SuggestionCard",
          entityId: card.id,
          meta: { kind: card.kind, decision, clinicId: card.clinicId } as object,
        },
      })
      .catch(() => undefined);

    log.info(
      { cardId: card.id, kind: card.kind, decision, staffId: ctx.staff.id },
      "suggestions: decided"
    );
    return NextResponse.json({ ok: true, status: decision });
  }
);
