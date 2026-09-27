import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess, scopedClinicSet } from "@/lib/rbac";
import { hit } from "@/lib/rate-limit";
import { handle } from "@/lib/api-error";

/**
 * GET /api/search?q=&type=contact|message[&internal=1][&before=...][&beforeId=...] — 全文搜尋（MD §6.4 + cwi-final S6-3）。
 *
 * - Contact：waId 子字串（字面 + 電話號碼 digits）+ profileName ILIKE（中文 fuzzy）/ pg_trgm similarity
 * - Message：body ILIKE（中文/廣東話）+ 電話號碼 digits → Contact.waId
 *   （★ S6-3：tsvector(english) 已移除 — 對中文無用，仲令短 query 行 seq scan）
 * - ★ S6-3（audit3 P1-20）：整次 query 包喺 $transaction + SET LOCAL statement_timeout='3s'
 *   （1-2 字中文 ILIKE seq scan 保護 — 超時 = 504，唔 hang 住 connection pool）
 * - ★ S6-3：channel=INTERNAL 預設排除（?internal=1 toggle「搜尋內部備註」）；voidedAt IS NOT NULL 排除
 * - ★ S6-3：電話號碼 — q 剔非 digits，≥4 位 → waId LIKE '%digits%'（「9123 4567」/「+852-9123-4567」搵到 85291234567）
 * - ★ S6-3：before keyset cursor — message = (waTimestamp DESC, id DESC)；contact = (similarity DESC, id DESC)
 *   （before = 上一頁最後一行 sort key；beforeId = 上一頁最後一行 id 做 tiebreak）
 *
 * Scope：cwi-h6-20260830 多店 — STAFF 可搜 = 自己綁定店集合 + 我係 assignee 嘅對話（單線授權，
 * message 分支）；ADMIN 可 ?clinicId= 指定。
 * ★ q 一律 bind parameter 传入（唔插值入 SQL），body 內容只以 snippet 形式
 *   回傳畀已授權 UI（正常業務數據，唔係 log）。
 */
export const dynamic = "force-dynamic";

/**
 * ★ L-2：LIKE/ILIKE 通配符 escape — q 一直係 bind parameter（唔係注入），
 * 但 q 入面嘅 `%`/`_` 會當 LIKE 通配符用（`%` = 匹配全部、`_` = 匹配單字元），
 * 改變搜尋語義。escape 之後按字面匹配。Postgres LIKE 預設 escape 字元係 `\`。
 * （similarity 唔係 LIKE，唔需要 escape，照用原 q。）
 */
function escapeLikeWildcards(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** keyset cursor 時間戳解讀（同 /messages 路由同寫法）— 解唔到 = null（ignore cursor） */
function parseTs(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface ContactHit {
  id: string;
  waId: string;
  profileName: string | null;
  labels: string[];
  clinicId: string;
}

interface MessageHit {
  id: string;
  conversationId: string;
  direction: string;
  type: string;
  snippet: string | null;
  waTimestamp: Date;
  clinicId: string;
  contactWaId: string;
  contactName: string | null;
}

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  // ★ S3-6：search per staff 30/分鐘（全文搜尋 DB 成本 — 防爬）
  if (!(await hit(`search:staff:${ctx.staff.id}`, 30, 60))) {
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const type = url.searchParams.get("type") ?? "contact";
  if (q.length < 1) return NextResponse.json({ error: "q required" }, { status: 400 });
  if (q.length > 200) return NextResponse.json({ error: "q too long" }, { status: 400 });

  // ★ S6-3：?internal=1 — 搜尋內部備註（channel=INTERNAL）toggle（預設排除）
  const includeInternal = url.searchParams.get("internal") === "1";
  // ★ S6-3：電話號碼 digits（剔晒非 digits；≥4 位先當電話搜 — 1-3 位誤報太多）
  const digits = q.replace(/\D/g, "");
  const isPhone = digits.length >= 4;
  // ★ S6-3：keyset cursor（message = waTimestamp ISO/epoch；contact = 上一頁最後 similarity score）
  const beforeParam = url.searchParams.get("before");
  const beforeIdParam = url.searchParams.get("beforeId");
  const cursorTs = parseTs(beforeParam); // message 分支用
  const cursorScore = beforeParam !== null && Number.isFinite(Number(beforeParam)) ? Number(beforeParam) : null; // contact 分支用
  const cursorOnMsg = cursorTs !== null;
  const cursorOnContact = cursorScore !== null;

  // cwi-hub-a-20260914（Part A）：scope-aware — clinicParam 外範圍 → 403（任何受限角色）；
  //   無 clinicParam = 自己範圍集合（ALL scope / SUPERVISOR = null = 無店限制）
  const clinicParam = url.searchParams.get("clinicId");
  if (clinicParam) assertClinicAccess(ctx, clinicParam);
  const clinicIds: string[] | null = clinicParam ? [clinicParam] : scopedClinicSet(ctx);
  const selfId = ctx.staff.id; // 單線授權：我係 assignee 嘅對話（外店派咗落嚟嗰條線）
  // ★ L-2：ILIKE/LIKE 用 escape 後嘅值（bind 照樣）；similarity 用原 q
  const qEsc = escapeLikeWildcards(q);

  /**
   * ★ S6-3：statement_timeout 保護 — SET LOCAL 只有效呢個 transaction 內。
   * 游標子句寫法：`${cursorOn} = false OR ...` — cursor 唔使時整句 = false（唔改 base query）。
   */
  let rows: (ContactHit | MessageHit)[];
  try {
    rows = await prisma.$transaction(
      async (tx): Promise<(ContactHit | MessageHit)[]> => {
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3s'");
        if (type === "message") {
          return clinicIds
            ? await tx.$queryRaw<MessageHit[]>`
                SELECT m.id, m."conversationId", m.direction, m.type,
                       left(m.body, 80) AS snippet, m."waTimestamp",
                       cv."clinicId", c."waId" AS "contactWaId", c."profileName" AS "contactName"
                FROM "Message" m
                JOIN "Conversation" cv ON cv.id = m."conversationId"
                JOIN "Contact" c ON c.id = cv."contactId"
                WHERE (cv."clinicId" = ANY(${clinicIds}) OR cv."assigneeId" = ${selfId})
                  AND m."voidedAt" IS NULL
                  AND (${includeInternal} OR m."channel" <> 'INTERNAL')
                  AND (
                    coalesce(m.body, '') ILIKE '%' || ${qEsc} || '%'
                    OR (${isPhone} AND c."waId" LIKE '%' || ${digits} || '%')
                  )
                  AND (
                    ${cursorOnMsg} = false
                    OR m."waTimestamp" < ${cursorTs}
                    OR (m."waTimestamp" = ${cursorTs} AND m.id < ${beforeIdParam ?? null})
                  )
                ORDER BY m."waTimestamp" DESC, m.id DESC
                LIMIT 20`
            : await tx.$queryRaw<MessageHit[]>`
                SELECT m.id, m."conversationId", m.direction, m.type,
                       left(m.body, 80) AS snippet, m."waTimestamp",
                       cv."clinicId", c."waId" AS "contactWaId", c."profileName" AS "contactName"
                FROM "Message" m
                JOIN "Conversation" cv ON cv.id = m."conversationId"
                JOIN "Contact" c ON c.id = cv."contactId"
                WHERE m."voidedAt" IS NULL
                  AND (${includeInternal} OR m."channel" <> 'INTERNAL')
                  AND (
                    coalesce(m.body, '') ILIKE '%' || ${qEsc} || '%'
                    OR (${isPhone} AND c."waId" LIKE '%' || ${digits} || '%')
                  )
                  AND (
                    ${cursorOnMsg} = false
                    OR m."waTimestamp" < ${cursorTs}
                    OR (m."waTimestamp" = ${cursorTs} AND m.id < ${beforeIdParam ?? null})
                  )
                ORDER BY m."waTimestamp" DESC, m.id DESC
                LIMIT 20`;
        }
        return clinicIds
          ? await tx.$queryRaw<ContactHit[]>`
              SELECT id, "waId", "profileName", labels, "clinicId"
              FROM "Contact"
              WHERE "clinicId" = ANY(${clinicIds})
                AND (
                  "waId" LIKE '%' || ${qEsc} || '%'
                  OR (${isPhone} AND "waId" LIKE '%' || ${digits} || '%')
                  OR coalesce("profileName", '') ILIKE '%' || ${qEsc} || '%'
                  OR similarity(coalesce("profileName", ''), ${q}) > 0.3
                )
                AND (
                  ${cursorOnContact} = false
                  OR similarity(coalesce("profileName", ''), ${q}) < ${cursorScore}
                  OR (similarity(coalesce("profileName", ''), ${q}) = ${cursorScore} AND id < ${beforeIdParam ?? null})
                )
              ORDER BY similarity(coalesce("profileName", ''), ${q}) DESC, id DESC
              LIMIT 20`
          : await tx.$queryRaw<ContactHit[]>`
              SELECT id, "waId", "profileName", labels, "clinicId"
              FROM "Contact"
              WHERE (
                "waId" LIKE '%' || ${qEsc} || '%'
                OR (${isPhone} AND "waId" LIKE '%' || ${digits} || '%')
                OR coalesce("profileName", '') ILIKE '%' || ${qEsc} || '%'
                OR similarity(coalesce("profileName", ''), ${q}) > 0.3
              )
              AND (
                ${cursorOnContact} = false
                OR similarity(coalesce("profileName", ''), ${q}) < ${cursorScore}
                OR (similarity(coalesce("profileName", ''), ${q}) = ${cursorScore} AND id < ${beforeIdParam ?? null})
              )
              ORDER BY similarity(coalesce("profileName", ''), ${q}) DESC, id DESC
              LIMIT 20`;
      },
    );
  } catch (e) {
    // PG 57014 / "canceling statement due to statement timeout" → 504（唔係 500 — 語義：太慢，唔係 bug）
    if (e instanceof Error && e.message.includes("statement timeout")) {
      return NextResponse.json({ error: "search timed out" }, { status: 504 });
    }
    throw e;
  }
  return NextResponse.json({ type, results: rows });
});
