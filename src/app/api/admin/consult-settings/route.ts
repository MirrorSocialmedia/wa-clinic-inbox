/**
 * ★ consult v2.1 C5（MD §8.1 Tab 2/3）：AI 傾偈設定 Admin API（ADMIN-only，同 knowledge 同級）。
 *
 * GET  /api/admin/consult-settings?clinicId=<id>
 *      — 回 effective（global→clinic merge 後，同 engine 同一口徑 loadConsultSettings）
 *        + raw（global / clinic 兩層原值 — UI 顯示「邊層改咗」）+ 出廠 default（UI reset 用）。
 * PUT  /api/admin/consult-settings
 *      — body { clinicId: string|null, key: rules|discovery|advanced, value: object }
 *        → upsert（clinicId null = 全局層；application 層守衛 global 唯一 — PG NULL 唔受 unique 約束）。
 *        zod 驗證 value shape → 400。audit CONSULT_SETTINGS_UPDATE（零 PII：key + clinicId）。
 *        即時生效（engine 每 turn fresh load — 「AI 下一次回覆即刻生效」）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import prisma from "@/lib/prisma";
import {
  CONSULT_SETTING_KEYS,
  type ConsultSettingKey,
  loadConsultSettings,
  rulesValueInput,
  discoveryValueInput,
  advancedValueInput,
  CONSULT_SETTING_DEFAULTS,
} from "@/lib/sessions/consult-settings";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

const VALUE_VALIDATORS: Record<ConsultSettingKey, (raw: unknown) => boolean> = {
  rules: (raw) => rulesValueInput(raw).success,
  discovery: (raw) => discoveryValueInput(raw).success,
  advanced: (raw) => advancedValueInput(raw).success,
};

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const clinicId = req.nextUrl.searchParams.get("clinicId") ?? null;
  const effective = await loadConsultSettings(prisma, clinicId);
  const rows = await prisma.consultSetting.findMany({
    where: { key: { in: [...CONSULT_SETTING_KEYS] }, OR: [{ clinicId: null }, ...(clinicId ? [{ clinicId }] : [])] },
  });
  const raw: { global: Record<string, unknown>; clinic: Record<string, unknown> } = { global: {}, clinic: {} };
  for (const r of rows) {
    if (r.clinicId === null) raw.global[r.key] = r.value;
    else if (clinicId && r.clinicId === clinicId) raw.clinic[r.key] = r.value;
  }
  return NextResponse.json({
    clinicId,
    role: ctx.staff.role,
    // Set → plain object（JSON.stringify(Set) = {} — 序列化陷阱）
    effective: {
      ...effective,
      disabledRules: Object.fromEntries(Array.from(effective.disabledRules).map((k) => [k, true] as [string, boolean])),
    },
    raw,
    defaults: {
      rules: CONSULT_SETTING_DEFAULTS.rules,
      discovery: { questions: CONSULT_SETTING_DEFAULTS.discovery.questions, askBudget: false },
      advanced: { ...CONSULT_SETTING_DEFAULTS.advanced, extraTriggerWords: [] },
    },
  });
});

export const PUT = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const { clinicId, key, value } = body as { clinicId?: string | null; key?: string; value?: unknown };
  if (!CONSULT_SETTING_KEYS.includes(key as ConsultSettingKey)) {
    return NextResponse.json({ error: "validation failed", message: `key must be one of ${CONSULT_SETTING_KEYS.join(" | ")}` }, { status: 400 });
  }
  const k = key as ConsultSettingKey;
  if (!VALUE_VALIDATORS[k](value)) {
    return NextResponse.json({ error: "validation failed", message: `value shape invalid for key ${k}` }, { status: 400 });
  }
  const scopeClinic = typeof clinicId === "string" && clinicId.length > 0 ? clinicId : null;

  // global 唯一守衛（PG NULL 唔受 unique 約束）— find-first 再 update/create
  let row = await prisma.consultSetting.findFirst({ where: { clinicId: scopeClinic, key: k }, select: { id: true } });
  if (row) {
    await prisma.consultSetting.update({ where: { id: row.id }, data: { value: value as object } });
  } else {
    row = await prisma.consultSetting.create({ data: { clinicId: scopeClinic, key: k, value: value as object } });
  }
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "CONSULT_SETTINGS_UPDATE",
      entity: "ConsultSetting",
      entityId: row.id,
      meta: { clinicId: scopeClinic, key: k } as object,
    },
  });
  log.info({ staffId: ctx.staff.id, clinicId: scopeClinic, key: k }, "consult-settings: updated");
  const effective = await loadConsultSettings(prisma, scopeClinic);
  // Set → plain object（JSON.stringify(Set) = {} — 序列化陷阱）
  return NextResponse.json({
    ok: true,
    key: k,
    clinicId: scopeClinic,
    effective: {
      ...effective,
      disabledRules: Object.fromEntries(Array.from(effective.disabledRules).map((x) => [x, true] as [string, boolean])),
    },
  });
});
