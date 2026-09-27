import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * PATCH /api/staff/me/prefs — per-staff UI 偏好（cwi-final S6-9 ③）。
 *
 * 只改自己（session staff — 冇 body 裡 staffId；結構上改唔到別人）。
 * Shallow merge 入 StaffUser.uiPrefs（Json）— 只收已知 key（whitelist，防未知欄位汙染）。
 * 回傳 merge 後嘅新 uiPrefs（client optimistic 寫入後對齊）。
 *
 * 目前 keys：
 * - enterSends: boolean — composer「Enter 發送」（預設 true = 現行為；false = Enter 換行 + Ctrl/⌘+Enter 發送）
 */
export const dynamic = "force-dynamic";

const PrefsBody = z.object({
  enterSends: z.boolean().optional(),
});

export const PATCH = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const raw = await req.json().catch(() => null);
  const body = PrefsBody.parse(raw ?? {});

  const staff = await prisma.staffUser.findUnique({ where: { id: ctx.staff.id } });
  if (!staff) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cur = (staff.uiPrefs ?? {}) as Prisma.JsonObject;
  const next: Prisma.JsonObject = { ...cur };
  if (body.enterSends !== undefined) next.enterSends = body.enterSends;

  const updated = await prisma.staffUser.update({
    where: { id: staff.id },
    data: { uiPrefs: next },
  });
  return NextResponse.json({ uiPrefs: updated.uiPrefs });
});
