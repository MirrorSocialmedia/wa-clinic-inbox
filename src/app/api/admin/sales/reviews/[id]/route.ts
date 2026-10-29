/**
 * ★ cwi-sales 第 2 期：POST /api/admin/sales/reviews/[id] — 老闆對單決定（集團管理員）。
 * body { decision: "APPROVED"|"REJECTED", approvedPct?: 0–100（預設 100）, note?（拒絕必填） }
 * 同一決定重撳 = 冪等；已決定成另一樣 → 409。AuditLog SALES_REVIEW_DECIDED（只 id + 決定）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { WorkforceApiError } from "@/lib/workforce/client";
import { SalesActionError } from "@/lib/sales/handover";
import { decideReviewFromInbox } from "@/lib/sales/reviews";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    approvedPct: z.number().min(0).max(100).nullish(),
    note: z.string().max(500).nullish(),
  })
  .strict();

const MESSAGES: Record<string, string> = {
  NOTE_REQUIRED: "拒絕要寫原因",
  BAD_PCT: "批核 % 要喺 0–100",
  ALREADY_DECIDED: "呢項已經決定咗",
  ADOPT_STAFF_REQUIRED: "呢張單嘅銷售員未綁 inbox 帳號",
  NOT_FOUND: "搵唔到呢項",
};

export const POST = handle(async (req: NextRequest, ctxP: Ctx) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以批對單" }, { status: 403 });
  const { id } = await ctxP.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "資料唔齊" }, { status: 400 });
  const b = parsed.data;
  if (b.decision === "REJECTED" && !(b.note ?? "").trim()) return NextResponse.json({ error: "NOTE_REQUIRED", message: MESSAGES.NOTE_REQUIRED }, { status: 400 });
  try {
    await decideReviewFromInbox(id, { decision: b.decision, approvedPct: b.approvedPct ?? null, note: b.note ?? null }, admin.staff.id);
  } catch (err) {
    if (err instanceof SalesActionError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    if (err instanceof WorkforceApiError) {
      const code = err.code ?? "WORKFORCE_ERROR";
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      return NextResponse.json({ error: code, message: MESSAGES[code] ?? "workforce 連唔到 — 請稍後再試" }, { status });
    }
    throw err;
  }
  await prisma.auditLog.create({
    data: { staffId: admin.staff.id, action: "SALES_REVIEW_DECIDED", entity: "SalesReview", entityId: id, meta: { decision: b.decision, pct: b.approvedPct ?? null } },
  });
  return NextResponse.json({ ok: true });
});
