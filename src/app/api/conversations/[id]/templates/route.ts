import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { approvedTemplateList } from "@/lib/wa/approved-templates";
import {
  confirmPreviewText,
  confirmTemplateName,
  reminderPreviewText,
  reminderTemplateName,
} from "@/lib/wa/templates";

/**
 * GET /api/conversations/[id]/templates — cwi-window-20260901（P3 / W-1）
 *
 * 過窗三出路 ②「揀 template」picker 資料：
 *   - 只列 APPROVED + UTILITY（同 send route 422/校驗同一來源 — 唔會列出發唔出嘅）
 *   - supported = v1 有 builder 可發（reminder/confirm 兩款）
 *   - prefill = 對話最新 CONFIRMED 預約（同 send route 自動填變數同源）+ 病人名 + 診所名
 *     → UI 顯示「變數已填好」；冇 booking → prefill=null（UI 提示需 CONFIRMED 預約）
 *
 * 零 PII：patientName 係 staff 已可喺 header 見到嘅 profileName（PII 白名單 v2 許可）；
 * 電話從唔落呢個 endpoint。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(auth, conv);

  // ★ schema 無 Conversation relation field → 分開查（同 patient-appointments/cancel route pattern）
  const [contact, clinic] = await Promise.all([
    prisma.contact.findUnique({
      where: { id: conv.contactId },
      select: { profileName: true },
    }),
    prisma.clinic.findUnique({
      where: { id: conv.clinicId },
      select: { id: true, name: true, waBusinessAccountId: true },
    }),
  ]);
  if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 404 });

  const all = await approvedTemplateList(clinic);
  const reminderName = reminderTemplateName();
  const confirmName = confirmTemplateName();

  // 變數預填：最新 CONFIRMED 預約（同 send route 自動填同源）
  const br = await prisma.bookingRequest.findFirst({
    where: { conversationId: conv.id, status: "CONFIRMED" },
    orderBy: { createdAt: "desc" },
    select: { requestedDate: true, requestedTime: true, providerName: true },
  });
  const prefill =
    br && br.requestedTime
      ? {
          patientName: contact?.profileName ?? null,
          clinicName: clinic.name,
          requestedDate: br.requestedDate,
          requestedTime: br.requestedTime,
          providerName: br.providerName,
        }
      : null;

  return NextResponse.json({
    templates: all.map((t) => {
      const supported = t.name === reminderName || t.name === confirmName;
      let preview: string | null = null;
      if (supported && prefill) {
        preview =
          t.name === reminderName
            ? reminderPreviewText({
                requestedDate: prefill.requestedDate,
                requestedTime: prefill.requestedTime,
                providerName: prefill.providerName,
                clinicName: prefill.clinicName,
              })
            : confirmPreviewText({
                requestedDate: prefill.requestedDate,
                requestedTime: prefill.requestedTime,
                providerName: prefill.providerName,
                clinicName: prefill.clinicName,
              });
      }
      return { name: t.name, language: t.language, category: t.category, supported, preview };
    }),
    prefill,
  });
});
