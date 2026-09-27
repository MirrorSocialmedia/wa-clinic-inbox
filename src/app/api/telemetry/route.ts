/**
 * /api/telemetry — ★ cwi-final S6-4（S1-2/S6-6 觸發指標）：client 回報事件。
 *
 * POST { "event": "listTruncated" } — 只收白名單事件、只計數（TelemetryCounter upsert +1）、
 * 唔收任何 payload 內容（禁 conversationId / 文字 / 任何 PII — 呢個 endpoint 設計上就唔可以留痕）。
 * - 已認證 staff 皆可（本質上無敏感操作：只係計數 +1）
 * - rate limit 60/分鐘（防濫用；正常觸發極少）
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/rbac";
import { hit } from "@/lib/rate-limit";
import { handle } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** 白名單事件 — 加新事件 = 改呢度 + metrics.ts 顯示（唔可以任意事件名入庫） */
const TELEMETRY_EVENTS = new Set(["listTruncated"]);

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  if (!(await hit(`telemetry:staff:${ctx.staff.id}`, 60, 60))) {
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }
  const body: unknown = await req.json().catch(() => null);
  const event = typeof body === "object" && body !== null && "event" in body ? (body as { event?: unknown }).event : undefined;
  if (typeof event !== "string" || !TELEMETRY_EVENTS.has(event)) {
    return NextResponse.json({ error: "unknown event" }, { status: 400 });
  }
  // 只計數 — atomic upsert（concurrent 安全）
  await prisma.$executeRaw`
    INSERT INTO "TelemetryCounter" ("key", "count", "updatedAt")
    VALUES (${event}, 1, now())
    ON CONFLICT ("key") DO UPDATE SET "count" = "TelemetryCounter"."count" + 1, "updatedAt" = now()
  `;
  return NextResponse.json({ ok: true });
});
