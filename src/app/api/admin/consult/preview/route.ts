/**
 * ★ consult v2.1 C5（MD §8.1 Tab 1 即時預覽區）：AI 回覆預覽 API。
 *
 * POST /api/admin/consult/preview
 *      body { workflow: ORTHODONTIC_CONSULT|IMPLANT_CONSULT, clinicId: string|null, demoQuestion?: string }
 *
 * 用**真 pipeline**（同 worker 同一組函數）：
 *   usable 產品（isProductUsable 鐵律 — unapproved/disabled 唔入 prompt）
 *   → Call #1 抽槽（consultExtractSlots，temperature 0）
 *   → Call #2 生成（consultGenerateDraft，temperature 0.4，MD §6.2 payload 逐字欄位）
 *   → Claim Guard 九條（runClaimGuard，喺 price 範圍核對之上）。
 *
 * **鐵律（MD 生死格）：唔存 session、唔發送、唔計 usage — 只讀 + LLM call，零 DB 寫入。**
 *
 * 輸入 = 固定示範問題（每療程一條；e2e 可用 demoQuestion 覆寫送 CG bait 句）。
 * 輸出 = 草稿 + 三個醫生用白話核對結果（由 claim-guard 回傳）：
 *   ① 冇講「你一定要做邊款」（CG-003）
 *   ② 冇保證療程時間（CG-002/CG-004）
 *   ③ 有約評估（CTA 存在性 — 草稿含 評估/預約/約）
 * 任何 CG 命中 → blocked=true + cgCode（第一命中）+ 核對 ①② 對應紅 ✗ + 原因。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import prisma from "@/lib/prisma";
import { isProductUsable } from "@/lib/sessions/consult-products";
import {
  consultExtractSlots,
  consultGenerateDraft,
  type ConsultGeneratePayload,
} from "@/lib/ai/consult-llm";
import { runClaimGuard, CLAIM_HUMAN_TEXT } from "@/lib/ai/claim-guard";
import { selectPriceDisclaimer } from "@/lib/ai/price-guard";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

/** 固定示範問題（MD §8.1 預覽區逐字；每療程一條）。 */
const DEMO_QUESTIONS: Record<string, string> = {
  ORTHODONTIC_CONSULT: "我想箍牙，唔想俾人見到，又想快啲",
  IMPLANT_CONSULT: "我想做植牙，想多了解下",
};

const bodySchema = z.object({
  workflow: z.enum(["ORTHODONTIC_CONSULT", "IMPLANT_CONSULT"]),
  clinicId: z.string().min(1).nullable().optional(),
  demoQuestion: z.string().min(1).max(500).optional(),
});

/** 預覽固定 action（MD：固定示範問題 → 展示介紹方案回覆；唔跑完整 transition 表）。 */
const PREVIEW_ACTION: Record<string, { action: string; stage: string; candidateCategory: string | null }> = {
  ORTHODONTIC_CONSULT: { action: "PRESENT_OPTIONS", stage: "PRESENT_OPTIONS", candidateCategory: "CLEAR_ALIGNER" },
  IMPLANT_CONSULT: { action: "EDUCATE_DETAIL", stage: "EDUCATE", candidateCategory: null },
};

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const { workflow, demoQuestion } = parsed.data;
  const clinicId = parsed.data.clinicId ?? null;
  const question = demoQuestion ?? DEMO_QUESTIONS[workflow];

  // 1. 產品（鐵律：usable 先入 prompt；unapproved 計數俾 UI 顯示「未確認」警示）
  const all = await prisma.consultProduct.findMany({
    where: { workflow, OR: [{ clinicId }, { clinicId: null }] },
    orderBy: { sortOrder: "asc" },
  });
  const usable = all.filter(isProductUsable);
  const unapprovedCount = all.filter((p) => p.approvedAt === null).length;

  // 2. PRICE doc（引用 = 第一個 usable 產品嘅 priceDocTitle — 同 worker price chain 同口徑）
  const firstTitle = usable.find((p) => p.priceDocTitle)?.priceDocTitle ?? all.find((p) => p.priceDocTitle)?.priceDocTitle ?? null;
  let priceDoc: { priceMin: number | null; priceMax: number | null; shortDisclaimer: string | null; disclaimer: string | null } | null = null;
  if (firstTitle) {
    const doc = await prisma.knowledgeDoc.findFirst({
      where: { kind: "PRICE", title: firstTitle, OR: [{ clinicId }, { clinicId: null }] },
    });
    if (doc) priceDoc = { priceMin: doc.priceMin, priceMax: doc.priceMax, shortDisclaimer: doc.shortDisclaimer, disclaimer: doc.disclaimer };
  }

  // 3. Call #1 抽槽（真 pipeline — 失敗 → 502，唔靜默）
  let extract;
  try {
    extract = await consultExtractSlots({ text: question, workflow, recent: [] });
  } catch (err) {
    log.warn({ err: String(err), workflow }, "consult-preview: extract failed");
    return NextResponse.json({ error: "ai_unavailable", message: "AI 暫不可用，請再試一次" }, { status: 502 });
  }

  // 4. Call #2 生成（MD §6.2 payload 逐字欄位 — 同 runConsultLlmTurn 同一組）
  const pv = PREVIEW_ACTION[workflow];
  const payload: ConsultGeneratePayload = {
    action: pv.action,
    stage: pv.stage,
    workflow,
    candidateCategory: pv.candidateCategory,
    products: usable.map((p) => ({
      displayName: p.displayName,
      positioning: p.positioning,
      approvedWording: p.approvedWording,
      timeWording: p.timeWording,
    })),
    priceRange: priceDoc
      ? { min: priceDoc.priceMin, max: priceDoc.priceMax, shortDisclaimer: selectPriceDisclaimer(priceDoc) }
      : null,
    avoidPhrases: [...new Set(usable.flatMap((p) => p.avoidPhrases))],
    discoveryQuestion: null,
    recentMessages: [{ direction: "IN", body: question }],
  };
  let draft: string;
  let model: string | null;
  try {
    const gen = await consultGenerateDraft(payload);
    draft = gen.text;
    model = gen.model;
  } catch (err) {
    log.warn({ err: String(err), workflow }, "consult-preview: generate failed");
    return NextResponse.json({ error: "ai_unavailable", message: "AI 暫不可用，請再試一次" }, { status: 502 });
  }

  // 5. Claim Guard（九條；第一命中 = code；blocked → 草稿換人手提示，同 pipeline 同口徑）
  const cg = runClaimGuard({
    draft,
    products: usable.map((p) => ({ code: p.code, displayName: p.displayName, brand: p.brand, timeWording: p.timeWording, avoidPhrases: p.avoidPhrases })),
    hasBackendSlot: false,
    priceDoc: priceDoc ? { priceMin: priceDoc.priceMin, priceMax: priceDoc.priceMax } : null,
  });
  const shownDraft = cg.blocked ? CLAIM_HUMAN_TEXT : draft;

  // 6. 三個醫生用白話核對（MD §8.1 預覽區逐字 label）
  const hasCta = /評估|預約|約/.test(shownDraft);
  const checks = [
    { label: "冇講「你一定要做邊款」", pass: !cg.codes.includes("CG-003"), reason: cg.codes.includes("CG-003") ? "草稿有未經評估嘅個人化建議" : null },
    { label: "冇保證療程時間", pass: !(cg.codes.includes("CG-004") || cg.codes.includes("CG-002")), reason: cg.codes.includes("CG-004") ? "草稿出現冇根據嘅療程時間" : cg.codes.includes("CG-002") ? "草稿有保證性講法" : null },
    { label: "有約評估", pass: hasCta, reason: hasCta ? null : "草稿冇安排評估嘅推進句" },
  ];

  log.info({ staffId: ctx.staff.id, workflow, clinicId, blocked: cg.blocked, code: cg.code }, "consult-preview: done");
  return NextResponse.json({
    ok: true,
    workflow,
    demoQuestion: question,
    draft: shownDraft,
    model,
    mock: /mock/i.test(model ?? ""),
    blocked: cg.blocked,
    cgCode: cg.code,
    cgCodes: cg.codes,
    checks,
    usableProducts: usable.length,
    unapprovedCount,
    extract: { slotUpdates: extract.slotUpdates, objection: extract.objection },
  });
});
