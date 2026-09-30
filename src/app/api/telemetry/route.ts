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
import { getAppRedis } from "@/lib/queue";
import { handle } from "@/lib/api-error";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

/** 白名單事件 — 加新事件 = 改呢度 + metrics.ts 顯示（唔可以任意事件名入庫） */
const TELEMETRY_EVENTS = new Set(["listTruncated"]);

/** ★ cwi-qa FX-32（QA-32）：per-staff 每日 dedup TTL — 90000s（25h）：覆蓋一個 HKT 日 + 日界容錯。
 *  Redis key 冇過期前同 staff 同日同事件只計 1 次（SET NX）；過期 = 新日（date 欄已換）。
 *  90000 大過 24h 係刻意：日界前後兩邊嘅 key（舊日/新日）會短暫並存，各計 1 次（正確）；
 *  若 EX 只係 24h，日界前 1 分鐘 set 嘅 key 會喺新日初仍有效 → 新日頭一筆漏計。 */
const TEL_DEDUP_TTL_SEC = 90_000;

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
  // ★ cwi-qa FX-32（QA-32）：每 staff 每日每事件只計 1 次 —
  //   舊版每個 POST 都 +1（client refetch/重開 tab 風暴 → 指標膨脹失真）。
  //   SET ... NX：當日首筆 → "OK"（照計）；當日再筆 → null（跳過，client 照回 200 — 契約不變）。
  //   date 用 HKT（同 app 全口徑）；Redis 失敗 → fail-open 照計（同 rate-limit hit() 口徑 —
  //   指標漏 1 次可接受，500 唔可接受）。
  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
  let firstToday = true;
  try {
    const r = await getAppRedis().set(`tel:${event}:${ctx.staff.id}:${dateStr}`, "1", "EX", TEL_DEDUP_TTL_SEC, "NX");
    firstToday = r === "OK";
  } catch (err) {
    log.warn(
      { staffId: ctx.staff.id, event, err: err instanceof Error ? err.message : String(err) },
      "telemetry: dedup Redis 失敗 — fail-open 照計（FX-32）"
    );
  }
  if (firstToday) {
    // 只計數 — atomic upsert（concurrent 安全）
    await prisma.$executeRaw`
      INSERT INTO "TelemetryCounter" ("key", "count", "updatedAt")
      VALUES (${event}, 1, now())
      ON CONFLICT ("key") DO UPDATE SET "count" = "TelemetryCounter"."count" + 1, "updatedAt" = now()
    `;
  }
  return NextResponse.json({ ok: true });
});
