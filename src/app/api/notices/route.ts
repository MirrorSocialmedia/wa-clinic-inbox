import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import { noticesGet, noticesPatch } from "./handler-core";

/**
 * /api/notices — 內部通知 bell（GET 未讀清單 / PATCH 標已讀）。
 *
 * ★ cwi-qa FX-16：Next 15 build 嚴校 route module 導出 — 只准 route field
 *   （GET/PATCH/dynamic/...），unknown named export = build 硬紅
 *   （FX-03（16a11ad）將 handler core 抽為呢度 named export → "handleNoticesGet
 *   is not a valid Route export field"）。handler core 已移去 ./handler-core
 *   （出口名 noticesGet/noticesPatch，unit test 直調呢度，唔經 HTTP）。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  return noticesGet(ctx, new URL(req.url).searchParams.get("clinicId"));
});

export const PATCH = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  return noticesPatch(ctx, body);
});
