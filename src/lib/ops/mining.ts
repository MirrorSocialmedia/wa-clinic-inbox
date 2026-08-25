/**
 * 學習迴路 mining v1（Phase E — 誠實版，總綱 §6.5）。
 *
 * rule-based 揀證據俾 Kenneth 判斷，唔扮智能聚類（D-6：全部建議經人批）。
 * 由 stats-weekly cron 喺週統計跑完後調用。
 *
 * 三規則：
 * 1. FAQ       — 上週 SENT_EDITED 按 (店, intent) 分組 ≥5 → 卡（人手改寫多 = 可能欠 FAQ/知識）
 * 2. TEMPLATE  — 上週 QUESTION 類 DISCARDED ≥5 同店 → 卡（AI 建議成日被棄 = 考慮標準答案）
 * 3. WORKFLOW_DIFF — 上週 booking-session HANDOFF 佔比 >30% → 卡（出 Phase D saveDraft 建議，
 *                    批准後只到 DRAFT — 兩段式，發佈先生效）
 *
 * 冪等：fingerprint 落 payload.fingerprint；同 (kind, clinicId, fingerprint) 已有
 *   PROPOSED/APPROVED 卡 → 唔重出（REJECTED 唔擋 — 批過「唔要」後數據變化可以再出，由人再決）。
 *
 * PII 鐵律：evidence 內任何文本必經 scrubAiSummary（用該對話 contact 身份）；
 *   wamid 只做 reference（UI 撳先跳 inbox 睇原文 — 卡唔複製原文）。
 *   log 只出 count/metadata（零文本）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { scrubAiSummary } from "@/lib/ai/scrub";
import { weekRangeUtc } from "./automation-stats";
import { getActiveInfo } from "@/lib/workflow/store";

const DAY_MS = 86_400_000;
const MIN_GROUP = 5; // 規則 1/2 門檻
const HANDOFF_RATIO = 0.3; // 規則 3 門檻
const MIN_SESSIONS = 3; // 規則 3 樣本地板（1–2 條 session 嘅 100% 係噪音）
const MAX_SAMPLES = 10;

interface EvidenceSample {
  draftScrubbed: string;
  finalScrubbed?: string;
  wamid: string | null;
  /** 內部 id（非 PII）— UI 撳跳 inbox 對話（/inbox/inbox?conv=）；卡唔複製原文 */
  conversationId: string;
}

interface Candidate {
  kind: "FAQ" | "TEMPLATE" | "WORKFLOW_DIFF";
  clinicId: string;
  title: string;
  payload: Record<string, unknown>;
  evidence: { counts: Record<string, number>; samples: EvidenceSample[] };
}

/** 冪等檢查：同 (kind, clinicId, fingerprint) 已有 PROPOSED/APPROVED 卡 → true。 */
async function hasExistingCard(kind: string, clinicId: string, fingerprint: string): Promise<boolean> {
  const rows = await prisma.suggestionCard.findMany({
    where: {
      kind,
      clinicId,
      status: { in: ["PROPOSED", "APPROVED"] },
      createdAt: { gte: new Date(Date.now() - 365 * DAY_MS) }, // 有界掃描（一年內卡片量極細）
    },
    select: { payload: true },
  });
  return rows.some((r) => {
    const p = r.payload as { fingerprint?: unknown } | null;
    return typeof p?.fingerprint === "string" && p.fingerprint === fingerprint;
  });
}

async function createCard(c: Candidate): Promise<string> {
  const row = await prisma.suggestionCard.create({
    data: {
      clinicId: c.clinicId,
      kind: c.kind,
      title: c.title,
      payload: c.payload as object,
      evidence: c.evidence as object,
    },
  });
  // 每張卡一張 StaffNotice（SUGGESTION_READY — Phase A 已建 enum；admin 見）
  await prisma.staffNotice
    .create({
      data: {
        clinicId: c.clinicId,
        kind: "SUGGESTION_READY",
        title: `新建議：${c.title}`,
        meta: { cardId: row.id, kind: c.kind } as object,
      },
    })
    .catch((err) => log.warn({ cardId: row.id, err: err instanceof Error ? err.message : String(err) }, "mining: StaffNotice 寫失敗（不阻卡片）"));
  return row.id;
}

export async function runMining(weekStart: string): Promise<{ cards: number }> {
  const [lo, hi] = weekRangeUtc(weekStart);
  const candidates: Candidate[] = [];

  const clinics = await prisma.clinic.findMany({ select: { id: true, code: true } });
  const clinicCode = (id: string) => clinics.find((c) => c.id === id)?.code ?? id.slice(0, 8);

  // 共用載入：上週相關 drafts + conversation→clinic/contact + contact 身份 + wamid
  const drafts = await prisma.aiDraft.findMany({
    where: { createdAt: { gte: lo, lt: hi }, status: { in: ["SENT_EDITED", "DISCARDED"] } },
    select: {
      id: true,
      conversationId: true,
      inReplyToMessageId: true,
      intent: true,
      status: true,
      draftText: true,
      finalText: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (drafts.length > 0) {
    const convIds = [...new Set(drafts.map((d) => d.conversationId))];
    const convs = await prisma.conversation.findMany({
      where: { id: { in: convIds } },
      select: { id: true, clinicId: true, contactId: true },
    });
    const contactIds = [...new Set(convs.map((c) => c.contactId))];
    const contacts = await prisma.contact.findMany({
      where: { id: { in: contactIds } },
      select: { id: true, waId: true, profileName: true },
    });
    const msgIds = [...new Set(drafts.map((d) => d.inReplyToMessageId))];
    const msgs = await prisma.message.findMany({
      where: { id: { in: msgIds } },
      select: { id: true, waMessageId: true },
    });
    const convOf = new Map(convs.map((c) => [c.id, c]));
    const contactOf = new Map(contacts.map((c) => [c.id, c]));
    const wamidOf = new Map(msgs.map((m) => [m.id, m.waMessageId]));

    const scrub = (text: string, convId: string): string => {
      const conv = convOf.get(convId);
      const contact = conv ? contactOf.get(conv.contactId) : undefined;
      return scrubAiSummary(text, { waId: contact?.waId, profileName: contact?.profileName });
    };
    const sampleOf = (d: (typeof drafts)[number]): EvidenceSample => ({
      draftScrubbed: scrub(d.draftText, d.conversationId),
      ...(d.finalText ? { finalScrubbed: scrub(d.finalText, d.conversationId) } : {}),
      wamid: wamidOf.get(d.inReplyToMessageId) ?? null,
      conversationId: d.conversationId,
    });
    const clinicOfConv = (convId: string): string | null => convOf.get(convId)?.clinicId ?? null;

    // ── 規則 1 → FAQ：SENT_EDITED 按 (店, intent) 分組 ≥5 ──
    const editedGroups = new Map<string, (typeof drafts)[number][]>();
    for (const d of drafts) {
      if (d.status !== "SENT_EDITED" || !d.intent) continue;
      const clinicId = clinicOfConv(d.conversationId);
      if (!clinicId) continue;
      const key = `${clinicId}|${d.intent}`;
      const g = editedGroups.get(key) ?? [];
      g.push(d);
      editedGroups.set(key, g);
    }
    for (const [key, group] of editedGroups) {
      if (group.length < MIN_GROUP) continue;
      const [clinicId, category] = key.split("|");
      const fingerprint = `faq:${clinicId}:${category}:${weekStart}`;
      if (await hasExistingCard("FAQ", clinicId, fingerprint)) continue;
      candidates.push({
        kind: "FAQ",
        clinicId,
        title: `${clinicCode(clinicId)}·${category}：上週 ${group.length} 條草稿被人手改寫 — 可能欠 FAQ/知識`,
        // v1 唔叫 LLM 代寫 — Kenneth 睇完證據自己填 Q/A（decide 時 edits.faq）
        payload: { proposedFaq: null, category, count: group.length, fingerprint },
        evidence: { counts: { totalEdited: group.length }, samples: group.slice(0, MAX_SAMPLES).map(sampleOf) },
      });
    }

    // ── 規則 2 → TEMPLATE：QUESTION 類 DISCARDED ≥5 同店 ──
    const discardedByClinic = new Map<string, (typeof drafts)[number][]>();
    for (const d of drafts) {
      if (d.status !== "DISCARDED" || d.intent !== "QUESTION") continue;
      const clinicId = clinicOfConv(d.conversationId);
      if (!clinicId) continue;
      const g = discardedByClinic.get(clinicId) ?? [];
      g.push(d);
      discardedByClinic.set(clinicId, g);
    }
    for (const [clinicId, group] of discardedByClinic) {
      if (group.length < MIN_GROUP) continue;
      const fingerprint = `template:${clinicId}:${weekStart}`;
      if (await hasExistingCard("TEMPLATE", clinicId, fingerprint)) continue;
      candidates.push({
        kind: "TEMPLATE",
        clinicId,
        title: `${clinicCode(clinicId)}：上週 QUESTION AI 建議被棄 ${group.length} 次 — 考慮加標準答案`,
        payload: { category: "QUESTION", count: group.length, fingerprint },
        evidence: { counts: { totalDiscarded: group.length }, samples: group.slice(0, MAX_SAMPLES).map(sampleOf) },
      });
    }
  }

  // ── 規則 3 → WORKFLOW_DIFF：booking-session HANDOFF 佔比 >30%（Phase D 上咗先開）──
  const sessions = await prisma.bookingSession.findMany({
    where: { createdAt: { gte: lo, lt: hi } },
    select: { clinicId: true, status: true },
  });
  const byClinic = new Map<string, { total: number; handoff: number }>();
  for (const s of sessions) {
    const g = byClinic.get(s.clinicId) ?? { total: 0, handoff: 0 };
    g.total++;
    if (s.status === "HANDOFF") g.handoff++;
    byClinic.set(s.clinicId, g);
  }
  for (const [clinicId, g] of byClinic) {
    if (g.total < MIN_SESSIONS || g.handoff / g.total <= HANDOFF_RATIO) continue;
    const fingerprint = `wf:${clinicId}:booking-session:${weekStart}`;
    if (await hasExistingCard("WORKFLOW_DIFF", clinicId, fingerprint)) continue;
    const active = await getActiveInfo("booking-session", clinicId);
    const cur = active.params as { candidateCount: number; maxNoProgress: number; maxTurns: number } & Record<string, unknown>;
    // 誠實建議：放寬候選數 + 重試預算（都未超過 schema 上限先建議）
    const suggested = {
      ...cur,
      ...(cur.candidateCount < 8 ? { candidateCount: cur.candidateCount + 1 } : {}),
      ...(cur.maxNoProgress < 10 ? { maxNoProgress: cur.maxNoProgress + 1 } : {}),
    };
    candidates.push({
      kind: "WORKFLOW_DIFF",
      clinicId,
      title: `${clinicCode(clinicId)}：上週 ${g.handoff}/${g.total} session 轉人手（${Math.round((g.handoff / g.total) * 100)}%）— 建議調 booking-session 參數`,
      payload: {
        key: "booking-session",
        current: cur,
        suggestedParams: suggested,
        stats: { sessions: g.total, handoff: g.handoff, ratio: +(g.handoff / g.total).toFixed(3) },
        fingerprint,
      },
      evidence: { counts: { sessions: g.total, handoff: g.handoff }, samples: [] },
    });
  }

  let cards = 0;
  for (const c of candidates) {
    try {
      await createCard(c);
      cards++;
    } catch (err) {
      log.warn(
        { clinicId: c.clinicId, kind: c.kind, err: err instanceof Error ? err.message : String(err) },
        "mining: 建卡失敗（跳過，唔阻其他卡）"
      );
    }
  }
  log.info({ weekStart, candidates: candidates.length, cards }, "mining: done");
  return { cards };
}
