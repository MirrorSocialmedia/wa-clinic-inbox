import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess, clinicScope } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { enqueueOutboundSend } from "@/lib/queue";
import { getWindowState } from "@/lib/wa/window";
import { billingCategoryForTemplate, BILLING_SERVICE } from "@/lib/wa/billing";
import { assignConversation } from "@/lib/assign";
import {
  listMessageTemplates,
  waMock,
  type MessageTemplate,
} from "@/lib/wa/graph";
import {
  buildTemplateComponents,
  confirmPreviewText,
  confirmTemplateName,
  reminderPreviewText,
  reminderTemplateName,
  type TemplateInput,
} from "@/lib/wa/templates";

/**
 * POST /api/messages/send — 員工發訊息（框架 MD §6.3 + Phase B template 覆）。
 *
 * 1. RBAC：STAFF 只能發自己店嘅對話（assertConversationAccess → 403 實測）
 * 2. free-form（body）：窗口檢查 now - lastInboundAt < 24h 先准；
 *    過窗 → 422 + `templates` 欄（APPROVED + UTILITY 名單 — UI 轉 template 揀選）
 * 3. template（templateName）：窗口外合法（utility template 就係為呢個情境）；
 *    v1 只支援 appt_reminder_zh / appt_confirm_zh 兩款有 builder 嘅；
 *    變數（日期/時間/醫生）= client 帶 templateParams 或自動攞對話最新 CONFIRMED booking
 * 4. 寫 Message(OUT, API, QUEUED) + AuditLog(SEND)
 * 5. outboundQueue.add → worker 負責真發送（mock mode 回假 wamid）
 *
 * ★ PII：log 只 metadata（conversationId/templateName/狀態）— 預覽文字/變數內容唔入 log。
 */
export const dynamic = "force-dynamic";

const templateParamsSchema = z.object({
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  requestedTime: z.string().regex(/^\d{2}:\d{2}$/, "HH:mm"),
  providerName: z.string().min(1).max(100),
}).optional();

const schema = z
  .object({
    conversationId: z.string().min(1),
    body: z.string().min(1).max(4096).optional(), // WA text 上限 4096 chars
    // Phase B：template 發送（同 body 二揀一）— 過窗 422 後 UI 帶呢個字段重發
    templateName: z.string().min(1).max(120).optional(),
    templateParams: templateParamsSchema,
    // ★ realtime-p0 R1（cwi-rt-20260823-a1）：client 冪等 key（UUID）。
    // 每次「邏輯發送」一個 key；斷網 retry / 雙擊重發同 key → 命中已存在 Message
    // → 直接回舊 row 200（idempotentReplay: true）唔再入 queue（DB 1 條、病人收 1 條）。
    // optional：舊 client / e2e 唔帶 → 行為不變（無冪等）。
    clientMessageId: z.string().uuid().optional(),
  })
  .refine((d) => (d.body ? 1 : 0) + (d.templateName ? 1 : 0) === 1, {
    message: "body 同 templateName 必須二揀一",
  });

const ENQUEUE_TIMEOUT_MS = 1500;

/** APPROVED + UTILITY template 名單（422 回應 + template 發送校驗共用）。失敗回 []（唔阻 422）。 */
async function approvedTemplateList(clinic: { waBusinessAccountId: string | null }): Promise<MessageTemplate[]> {
  try {
    if (!clinic.waBusinessAccountId && !waMock()) return [];
    const all = await listMessageTemplates(clinic.waBusinessAccountId ?? "");
    return all.filter((t) => t.status === "APPROVED" && t.category === "UTILITY");
  } catch {
    return [];
  }
}

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const conv = await prisma.conversation.findUnique({
    where: { id: parsed.data.conversationId },
  });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(ctx, conv); // STAFF 砌別店 URL → 403

  // ★ H1 Send Lock（MD §3.2）：對話有負責人時，只有負責人可以發 WhatsApp。
  // 其他店內員工 → 423 SEND_LOCKED（UI composer 轉內部備註模式；INTERNAL note route 冇呢個檢查）。
  // cwi-h6-20260830（T97）：ADMIN 要先接手（變 assignee）先可以覆 — 非負責人（包 ADMIN）照 423（T57 迴歸）。
  // AI AUTO 派卡係 system sender（worker 直接寫 DB + queue），唔經呢個 HTTP route → 天然唔受 lock。
  if (conv.assigneeId && conv.assigneeId !== ctx.staff.id) {
    log.info(
      { clinicId: conv.clinicId, conversationId: conv.id, staffId: ctx.staff.id, assigneeId: conv.assigneeId },
      "send: 423 SEND_LOCKED（assignee 係其他 staff）"
    );
    return NextResponse.json(
      {
        error: "SEND_LOCKED",
        message: "此對話已有負責人 — 你只可發內部備註，或撳〔接手〕轉交畀自己",
        assigneeId: conv.assigneeId,
      },
      { status: 423 }
    );
  }

  // Phase B：free-form vs template 二分流（template 唔受 24h 窗口限制 — 佢就係過窗嘅合法路徑）
  const isTemplateSend = !!parsed.data.templateName;
  const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId } });
  if (!clinic) return NextResponse.json({ error: "clinic missing" }, { status: 500 });

  let templateMeta: Prisma.InputJsonValue | undefined;
  let templateCategory: string | undefined; // cwi-window-20260901（P1）：template 類別（計費用）
  let templatePreview = "";
  if (isTemplateSend) {
    // ── template 發送校驗（失敗一律唔 claim / 唔落 Message）──
    if (!clinic.waBusinessAccountId && !waMock()) {
      return NextResponse.json(
        { error: "waba_not_configured", message: "呢間店未設定 WABA id — 唔可以發 template" },
        { status: 400 }
      );
    }
    let approved: MessageTemplate[];
    try {
      approved = await approvedTemplateList(clinic);
    } catch {
      return NextResponse.json({ error: "template_list_unavailable" }, { status: 502 });
    }
    const tpl = approved.find((t) => t.name === parsed.data.templateName);
    if (tpl) templateCategory = tpl.category; // cwi-window-20260901（P1）
    if (!tpl) {
      return NextResponse.json(
        {
          error: "template_not_found",
          message: "呢個 template 唔喺 APPROVED + UTILITY 名單（未審批/唔係 utility/已停用）",
          templates: approved.map((t) => ({ name: t.name, language: t.language })),
        },
        { status: 400 }
      );
    }
    const isReminder = tpl.name === reminderTemplateName();
    const isConfirm = tpl.name === confirmTemplateName();
    if (!isReminder && !isConfirm) {
      return NextResponse.json(
        {
          error: "template_not_supported",
          message: "v1 只支援 appt_reminder_zh / appt_confirm_zh（有 builder 嘅 template）",
        },
        { status: 400 }
      );
    }
    // 變數：client 帶 templateParams → 用；冇 → 自動攞對話最新 CONFIRMED booking（同 T-24h 提醒同源）
    let input: TemplateInput;
    if (parsed.data.templateParams) {
      input = { ...parsed.data.templateParams, clinicName: clinic.name };
    } else {
      const br = await prisma.bookingRequest.findFirst({
        where: { conversationId: conv.id, status: "CONFIRMED" },
        orderBy: { createdAt: "desc" },
      });
      if (!br || !br.requestedTime) {
        return NextResponse.json(
          { error: "template_params_required", message: "對話冇 CONFIRMED 預約 — 請帶 templateParams（日期/時間/醫生）" },
          { status: 400 }
        );
      }
      input = { requestedDate: br.requestedDate, requestedTime: br.requestedTime, providerName: br.providerName, clinicName: clinic.name };
    }
    templateMeta = {
      name: tpl.name,
      language: tpl.language,
      // cwi-window-20260901（P1）：template 類別快照 — /admin/usage 計費同 backfill 冪等性用
      category: tpl.category,
      components: buildTemplateComponents(input),
    } as unknown as Prisma.InputJsonValue;
    templatePreview = isReminder ? reminderPreviewText(input) : confirmPreviewText(input);
    log.info(
      { clinicId: clinic.id, conversationId: conv.id, staffId: ctx.staff.id, templateName: tpl.name },
      "send: template send validated（window-closed 合法路徑）"
    );
  } else {
    // ── free-form：窗口檢查（fail-closed：lastInboundAt = null → 過窗）──
    const win = getWindowState(conv.lastInboundAt);
    if (!win.open) {
      const templates = await approvedTemplateList(clinic);
      log.info(
        { clinicId: clinic.id, conversationId: conv.id, staffId: ctx.staff.id, remainingHours: Math.round(win.remainingHours * 10) / 10 },
        "send: window closed, free-form rejected"
      );
      return NextResponse.json(
        {
          error: "window_closed",
          message: "24 小時客服窗口已過，只可以發 template（utility）",
          remainingHours: 0,
          // Phase B：UI composer 收到呢個欄 → 出 template 揀選（選完帶 templateName 重發）
          templates: templates.map((t) => ({ name: t.name, language: t.language })),
        },
        { status: 422 }
      );
    }
  }

  // clinicScope 佢都過一次（belt & braces：route 層嘅 fail-closed 驗證）
  void clinicScope(ctx);

  // ★ H1：unassigned 對話首發 → auto-claim 成為負責人（MD §3.2；AuditLog AUTO_CLAIM）。
  // 喺窗口檢查之後：窗口已過（422）嘅失敗發送唔會 claim。
  if (!conv.assigneeId) {
    await assignConversation({
      conversationId: conv.id,
      toStaffId: ctx.staff.id,
      by: "AUTO_CLAIM",
      byStaffId: ctx.staff.id,
    });
    conv.assigneeId = ctx.staff.id;
  }

  // ★ realtime-p0 R1：client 冪等 — 命中已存在 Message（同 clientMessageId）→ 回舊 row，
  // 唔入 queue、唔再計一次 auto-claim/draft link。放喺 423/window/auto-claim 之後：
  // 首次被 423/422 拒時冇 Message 落庫 → replay 會再次經過同一條拒因（語義一致）。
  if (parsed.data.clientMessageId) {
    const existing = await prisma.message.findUnique({
      where: { clientMessageId: parsed.data.clientMessageId },
    });
    if (existing) {
      log.info(
        {
          clinicId: conv.clinicId,
          conversationId: conv.id,
          messageId: existing.id,
          status: existing.status,
          clientMessageId: parsed.data.clientMessageId,
        },
        "send: idempotent replay（clientMessageId 命中，唔入 queue）"
      );
      return NextResponse.json(
        {
          ok: true,
          messageId: existing.id,
          status: existing.status,
          idempotentReplay: true,
        },
        { status: 200 }
      );
    }
  }

  const now = new Date();
  let msg;
  try {
    msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT" as const,
        channel: "API" as const,
        type: isTemplateSend ? "template" : "text",
        // refine 已保證：非 template 分支 body 必有值
        body: isTemplateSend ? templatePreview : parsed.data.body!,
        // Phase B：template row 先有 templateMeta（text row 唔寫呢個欄）
        ...(isTemplateSend ? { templateMeta } : {}),
        // cwi-window-20260901（P1）：計費類別 — 人手窗口內 text = SERVICE；template 按其類別
        billingCategory: isTemplateSend ? billingCategoryForTemplate(templateCategory) : BILLING_SERVICE,
        status: "QUEUED" as const,
        sentByStaffId: ctx.staff.id,
        clientMessageId: parsed.data.clientMessageId ?? null,
        waTimestamp: now,
      },
    });
  } catch (err) {
    // ★ R1 race：兩個併發 POST 用同一 clientMessageId（雙 tab / 雙擊）— 一個先 commit，
    // 另一個 unique violation (P2002) → 當冪等 replay 回已 commit 嘅 row（200），唔回 500。
    if ((err as { code?: string } | null)?.code === "P2002" && parsed.data.clientMessageId) {
      const existing = await prisma.message.findUnique({
        where: { clientMessageId: parsed.data.clientMessageId },
      });
      if (existing) {
        log.info(
          { clinicId: conv.clinicId, conversationId: conv.id, messageId: existing.id, status: existing.status },
          "send: idempotent replay (P2002 race，唔入 queue)"
        );
        return NextResponse.json(
          { ok: true, messageId: existing.id, status: existing.status, idempotentReplay: true },
          { status: 200 }
        );
      }
    }
    throw err;
  }

  // cwi-h6-20260830（h5 §1 寫入點 2）：發送成功（入隊）— 負責人自己嘅動作 → 觸 assigneeLastActionAt。
  //   非負責人（ADMIN 豁免路徑）唔觸 — 呢個欄只反映現任負責人嘅活動。
  if (conv.assigneeId && conv.assigneeId === ctx.staff.id) {
    await prisma.$executeRaw`UPDATE "Conversation" SET "assigneeLastActionAt" = ${now} WHERE "id" = ${conv.id}`;
  }

  await prisma.$executeRaw`
    UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;

  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "SEND",
        entity: "Message",
        entityId: msg.id,
      },
    })
    .catch(() => undefined);

  // Phase 2：AI draft 採用追蹤（採用率 + 微調數據）。
  // 查對話最新嘅 PROPOSED draft（ai.worker 已將 Message.aiDraftId 指向佢）：
  // - 發出內容同 draft 一字不差 → SENT_AS_IS；改過 → SENT_EDITED（finalText 留底）
  // ★ 失敗唔準影響發送（try/catch 吞掉）— draft 統計只係观测数据。
  try {
    const linkedMsg = await prisma.message.findFirst({
      where: { conversationId: conv.id, direction: "IN", aiDraftId: { not: null } },
      orderBy: { waTimestamp: "desc" },
      select: { aiDraftId: true },
    });
    if (linkedMsg?.aiDraftId && parsed.data.body) {
      const draft = await prisma.aiDraft.findUnique({ where: { id: linkedMsg.aiDraftId } });
      if (draft && draft.conversationId === conv.id && draft.status === "PROPOSED") {
        const asIs = parsed.data.body.trim() === draft.draftText.trim();
        await prisma.aiDraft.update({
          where: { id: draft.id },
          data: { status: asIs ? "SENT_AS_IS" : "SENT_EDITED", finalText: parsed.data.body },
        });
        await prisma.message.update({ where: { id: msg.id }, data: { aiDraftId: draft.id } });
        log.info(
          { clinicId: conv.clinicId, conversationId: conv.id, draftId: draft.id, messageId: msg.id, adopted: asIs },
          "send: ai draft linked (SENT_AS_IS/SENT_EDITED)"
        );
      }
    }
  } catch (err) {
    log.warn(
      { clinicId: conv.clinicId, conversationId: conv.id, err: err instanceof Error ? err.message : String(err) },
      "send: ai draft link failed (ignored, 不影響發送)"
    );
  }

  try {
    await Promise.race([
      enqueueOutboundSend(msg.id),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    // queue fail：訊息留喺 DB（QUEUED）但冇 job — 標 FAILED 話知 UI，避免靜默
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: "FAILED", errorCode: "ENQUEUE_FAILED" },
    }).catch(() => undefined);
    log.error(
      { messageId: msg.id, err: err instanceof Error ? err.message : String(err) },
      "send: enqueue failed, message marked FAILED"
    );
    return NextResponse.json({ error: "queue unavailable" }, { status: 503 });
  }

  log.info(
    {
      clinicId: conv.clinicId,
      conversationId: conv.id,
      messageId: msg.id,
      staffId: ctx.staff.id,
      type: msg.type,
      // Phase B：template 發送 log 只帶 templateName（變數內容/預覽文字唔入 log）
      ...(isTemplateSend ? { templateName: parsed.data.templateName } : { bodyLen: parsed.data.body?.length ?? 0 }),
    },
    "send: queued"
  );
  return NextResponse.json({ ok: true, messageId: msg.id, status: "QUEUED" }, { status: 202 });
});
