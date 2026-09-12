/**
 * ★ consult v2.1 C2（MD §3）：ConsultSession API（對話子路由）。
 *
 * GET  /api/conversations/:id/consult-sessions
 *      — 該對話全部 session（最新優先）+ `active`（terminal=null 嗰條，最多一條）。
 *        8.2 側欄 CONSULT 狀態卡（C5 UI）+ e2e 斷言用。
 * POST /api/conversations/:id/consult-sessions
 *      — 開新 session（body: workflow 必填；stage/slots/… 可選，default 跟 model）。
 *        守衛（MD §3 鐵律）：同 conversation 只准一個 active（terminal=null）—
 *        重複 → 409。併發防線 = tx 內 Conversation 行鎖（FOR UPDATE）再 count。
 *
 * C1 橋接搬遷（MD §3 / C2 交接口）：session 建立時由 Conversation 過渡欄複製
 *   humanTookOver / lastOutboundText（session 級副本）；Conversation 欄保留
 *   （C1 e2e + 非 consult 路徑仍用），C3 起 consult 路徑改寫 session 欄。
 *
 * C3 規則引擎（worker 內）會直接用 Prisma 開 session（經同一守衛 helper）—
 *   呢個 API 服務 UI / e2e / 人手補開。
 *
 * ★ C5（MD §8.2）：PATCH 店員改動（側欄狀態卡動作）：
 *   body { sessionId, op: "assess" | "reset" | "resume" | "clearSlot", slotKey? }
 *   - assess    slots.clinicalSuitability = "ASSESSED"（鐵律：只有店員可改臨床判斷）
 *   - reset     重設 active session（stage DISCOVER / slots {} / objections [] / turnCount 0 /
 *               purchaseIntent 0 / ctaGiven false / humanTookOver false + Conversation 過渡欄同步清）
 *   - resume    交返 AI 繼續（humanTookOver=false — session + Conversation 兩層）
 *   - clearSlot 清除一個已知 slot（店員改 slot）— slotKey 必填
 *   全部 → audit `CONSULT_STATE_EDITED`（MD §8.2 逐字 action 名）。
 *   只准作用喺 active（terminal=null）session — terminal 嘅 409（唔會改歷史）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import prisma from "@/lib/prisma";
import { CONSULT_WORKFLOWS, type ConsultWorkflow } from "@/lib/sessions/consult-types";
import { loadConsultSettings } from "@/lib/sessions/consult-settings";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

function toSessionRow(s: {
  id: string; conversationId: string; clinicId: string; workflow: string; stage: string;
  terminal: string | null; slots: unknown; objections: unknown; candidateCategory: string | null;
  comparedProducts: string[]; askedSlots: string[]; turnCount: number; purchaseIntent: number;
  lastAction: string | null; nextAction: string | null; ctaGiven: boolean;
  humanTookOver: boolean; lastOutboundText: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: s.id,
    conversationId: s.conversationId,
    clinicId: s.clinicId,
    workflow: s.workflow,
    stage: s.stage,
    terminal: s.terminal,
    active: s.terminal === null, // ★ active = terminal IS NULL（UI/e2e 斷言口徑）
    slots: s.slots,
    objections: s.objections,
    candidateCategory: s.candidateCategory,
    comparedProducts: s.comparedProducts,
    askedSlots: s.askedSlots,
    turnCount: s.turnCount,
    purchaseIntent: s.purchaseIntent,
    lastAction: s.lastAction,
    nextAction: s.nextAction,
    ctaGiven: s.ctaGiven,
    humanTookOver: s.humanTookOver,
    lastOutboundText: s.lastOutboundText,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export const GET = handle(async (_req: NextRequest, { params }: Params) => {
  const ctx = await requireAuth(_req);
  const { id } = await params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv);
  const sessions = await prisma.consultSession.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: "desc" },
  });
  const rows = sessions.map(toSessionRow);
  const active = rows.find((s) => s.active) ?? null;
  // ★ C5（MD §8.2/§8.4）：conv.humanTookOver 係 live source（send route 一置就 live；session 欄係副本、
  //   下次 engine turn 先 sync）— 側欄卡「AI 已暫停」即時顯示要讀呢個。
  //   maxTurns = effective 設定（Tab 3；fail-soft → 8）— 側欄卡「對話輪數 n / 8」分母。
  const settings = await loadConsultSettings(prisma, conv.clinicId);
  return NextResponse.json({ conversationId: id, clinicId: conv.clinicId, convHumanTookOver: conv.humanTookOver, maxTurns: settings.advanced.maxTurns, active, sessions: rows });
});

export const POST = handle(async (req: NextRequest, { params }: Params) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv);
  assertCanWriteConversation(ctx); // 覆客寫入鐵律：SUPERVISOR 403

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const workflow = body.workflow;
  if (!CONSULT_WORKFLOWS.includes(workflow)) {
    return NextResponse.json({ error: "validation failed", message: `workflow must be one of ${CONSULT_WORKFLOWS.join(" | ")}` }, { status: 400 });
  }
  const stage = typeof body.stage === "string" && body.stage.length > 0 ? body.stage : "DISCOVER";
  const slots = body.slots && typeof body.slots === "object" ? body.slots : {};
  const objections = Array.isArray(body.objections) ? body.objections : [];
  const candidateCategory = typeof body.candidateCategory === "string" ? body.candidateCategory : null;

  // 守衛 + 建立同一 tx：Conversation 行鎖串行化同對話併發 create（防雙 active）。
  const result = await prisma.$transaction(async (tx) => {
    const _lock = await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${id} FOR UPDATE`;
    const existingActive = await tx.consultSession.findFirst({
      where: { conversationId: id, terminal: null },
      select: { id: true },
    });
    if (existingActive) return { conflict: existingActive.id, created: null };
    const created = await tx.consultSession.create({
      data: {
        conversationId: id,
        clinicId: conv.clinicId,
        workflow: workflow as ConsultWorkflow,
        stage,
        slots,
        objections,
        candidateCategory,
        // ★ C1 橋接搬遷：session 級副本由 Conversation 過渡欄複製（C3 起 consult 路徑只寫 session 欄）
        humanTookOver: conv.humanTookOver,
        lastOutboundText: conv.lastOutboundText,
      },
    });
    return { conflict: null, created };
  });

  if (result.conflict || !result.created) {
    return NextResponse.json(
      { error: "conflict", message: "該對話已有 active ConsultSession（terminal=null）", activeId: result.conflict ?? null },
      { status: 409 }
    );
  }
  const session = result.created;
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "CONSULT_SESSION_CREATE",
      entity: "ConsultSession",
      entityId: session.id,
      // 零 PII（conversationId + workflow 已夠追溯；不記 slots/文本）
      meta: { conversationId: id, clinicId: conv.clinicId, workflow: session.workflow, stage, bridgedFromConversation: { humanTookOver: conv.humanTookOver, hasLastOutboundText: conv.lastOutboundText != null } } as object,
    },
  });
  log.info({ staffId: ctx.staff.id, sessionId: session.id, conversationId: id, workflow: session.workflow }, "consult-sessions: created");
  return NextResponse.json(toSessionRow(session), { status: 201 });
});

// ── ★ C5（MD §8.2）：店員改動（側欄狀態卡） ──────────────────────────────

const CLEARABLE_SLOT_KEYS = new Set([
  "treatmentGoal", "appearancePriority", "speedPriority", "budgetSensitivity", "statedBudget",
  "customerProductInterest", "previousOrtho", "timeline", "missingCount", "missingDuration", "hasSeenDentist",
  "customerBrandInterest", "clinicalSuitability",
]);

export const PATCH = handle(async (req: NextRequest, { params }: Params) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv);
  assertCanWriteConversation(ctx); // 覆客寫入鐵律：SUPERVISOR 403

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const { sessionId, op, slotKey } = body as { sessionId?: string; op?: string; slotKey?: string };
  if (typeof sessionId !== "string" || !sessionId) return NextResponse.json({ error: "validation failed", message: "sessionId required" }, { status: 400 });
  if (!["assess", "reset", "resume", "clearSlot"].includes(op ?? "")) {
    return NextResponse.json({ error: "validation failed", message: "op must be assess | reset | resume | clearSlot" }, { status: 400 });
  }
  if (op === "clearSlot" && (typeof slotKey !== "string" || !CLEARABLE_SLOT_KEYS.has(slotKey))) {
    return NextResponse.json({ error: "validation failed", message: `slotKey must be one of ${[...CLEARABLE_SLOT_KEYS].join(", ")}` }, { status: 400 });
  }
  // 驗證後口徑：clearSlot 時 slotKey 必為 string
  const slotKeyFinal: string | null = op === "clearSlot" ? slotKey as string : null;

  const existing = await prisma.consultSession.findUnique({ where: { id: sessionId } });
  if (!existing || existing.conversationId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.terminal !== null) {
    return NextResponse.json({ error: "conflict", message: "session 已結束（terminal）— 唔可以改" }, { status: 409 });
  }

  let data: Record<string, unknown> = {};
  let convSync: Record<string, unknown> | null = null;
  if (op === "assess") {
    const slots = (existing.slots && typeof existing.slots === "object" ? existing.slots : {}) as Record<string, unknown>;
    if (slots.clinicalSuitability === "ASSESSED") {
      // 冪等：已評估 → 唔重複寫
      return NextResponse.json({ ok: true, op, changed: false, session: toSessionRow(existing) });
    }
    data = { slots: { ...slots, clinicalSuitability: "ASSESSED" } };
  } else if (op === "reset") {
    data = {
      stage: "DISCOVER", slots: {}, objections: [], candidateCategory: null, comparedProducts: [],
      askedSlots: [], turnCount: 0, purchaseIntent: 0, ctaGiven: false, lastAction: null, nextAction: null,
      humanTookOver: false, lastOutboundText: null,
    };
    // C1 橋接：Conversation 過渡欄同步清（店員重設 = 對話層都返轉頭）
    convSync = { humanTookOver: false };
  } else if (op === "resume") {
    if (!existing.humanTookOver && !conv.humanTookOver) {
      return NextResponse.json({ ok: true, op, changed: false, session: toSessionRow(existing) });
    }
    data = { humanTookOver: false };
    convSync = { humanTookOver: false };
  } else {
    // clearSlot — slotKeyFinal 必係 string（上面已驗證）
    const sk = slotKeyFinal as string;
    const slots = (existing.slots && typeof existing.slots === "object" ? existing.slots : {}) as Record<string, unknown>;
    if (!(sk in slots)) {
      return NextResponse.json({ ok: true, op, changed: false, session: toSessionRow(existing) });
    }
    const next = { ...slots };
    delete next[sk];
    data = { slots: next };
  }

  const updated = await prisma.consultSession.update({ where: { id: sessionId }, data });
  if (convSync) await prisma.conversation.update({ where: { id }, data: convSync });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "CONSULT_STATE_EDITED",
      entity: "ConsultSession",
      entityId: sessionId,
      meta: { conversationId: id, clinicId: conv.clinicId, op, slotKey: slotKeyFinal } as object,
    },
  });
  log.info({ staffId: ctx.staff.id, sessionId, op, slotKey: slotKey ?? null }, "consult-sessions: state edited");
  return NextResponse.json({ ok: true, op, changed: true, session: toSessionRow(updated) });
});
