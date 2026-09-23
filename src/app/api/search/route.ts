import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess, scopedClinicSet } from "@/lib/rbac";
import { hit } from "@/lib/rate-limit";
import { handle } from "@/lib/api-error";

/**
 * GET /api/search?q=&type=contact|message — 全文搜尋（MD §6.4）。
 *
 * - Contact：waId 子字串 + profileName pg_trgm similarity / ILIKE（中文 fuzzy）
 * - Message：tsvector(english)（英文 full-text）+ ILIKE（中文/廣東話 fallback）
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
 * （plainto_tsquery / similarity 唔係 LIKE，唔需要 escape，照用原 q。）
 */
function escapeLikeWildcards(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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

  // cwi-hub-a-20260914（Part A）：scope-aware — clinicParam 外範圍 → 403（任何受限角色）；
  //   無 clinicParam = 自己範圍集合（ALL scope / SUPERVISOR = null = 無店限制）
  const clinicParam = url.searchParams.get("clinicId");
  if (clinicParam) assertClinicAccess(ctx, clinicParam);
  const clinicIds: string[] | null = clinicParam ? [clinicParam] : scopedClinicSet(ctx);
  const selfId = ctx.staff.id; // 單線授權：我係 assignee 嘅對話（外店派咗落嚟嗰條線）
  // ★ L-2：ILIKE/LIKE 用 escape 後嘅值（bind 照樣）；tsvector/similarity 用原 q
  const qEsc = escapeLikeWildcards(q);

  if (type === "message") {
    const rows = clinicIds
      ? await prisma.$queryRaw<MessageHit[]>`
          SELECT m.id, m."conversationId", m.direction, m.type,
                 left(m.body, 80) AS snippet, m."waTimestamp",
                 cv."clinicId", c."waId" AS "contactWaId", c."profileName" AS "contactName"
          FROM "Message" m
          JOIN "Conversation" cv ON cv.id = m."conversationId"
          JOIN "Contact" c ON c.id = cv."contactId"
          WHERE (cv."clinicId" = ANY(${clinicIds}) OR cv."assigneeId" = ${selfId})
            AND (
              to_tsvector('english', coalesce(m.body, '')) @@ plainto_tsquery('english', ${q})
              OR coalesce(m.body, '') ILIKE '%' || ${qEsc} || '%'
            )
          ORDER BY m."waTimestamp" DESC
          LIMIT 20`
      : await prisma.$queryRaw<MessageHit[]>`
          SELECT m.id, m."conversationId", m.direction, m.type,
                 left(m.body, 80) AS snippet, m."waTimestamp",
                 cv."clinicId", c."waId" AS "contactWaId", c."profileName" AS "contactName"
          FROM "Message" m
          JOIN "Conversation" cv ON cv.id = m."conversationId"
          JOIN "Contact" c ON c.id = cv."contactId"
          WHERE
            to_tsvector('english', coalesce(m.body, '')) @@ plainto_tsquery('english', ${q})
            OR coalesce(m.body, '') ILIKE '%' || ${qEsc} || '%'
          ORDER BY m."waTimestamp" DESC
          LIMIT 20`;
    return NextResponse.json({ type, results: rows });
  }

  // default: contact
  const rows = clinicIds
    ? await prisma.$queryRaw<ContactHit[]>`
        SELECT id, "waId", "profileName", labels, "clinicId"
        FROM "Contact"
        WHERE "clinicId" = ANY(${clinicIds})
          AND (
            "waId" LIKE '%' || ${qEsc} || '%'
            OR coalesce("profileName", '') ILIKE '%' || ${qEsc} || '%'
            OR similarity(coalesce("profileName", ''), ${q}) > 0.3
          )
        ORDER BY similarity(coalesce("profileName", ''), ${q}) DESC, id
        LIMIT 20`
    : await prisma.$queryRaw<ContactHit[]>`
        SELECT id, "waId", "profileName", labels, "clinicId"
        FROM "Contact"
        WHERE
          "waId" LIKE '%' || ${qEsc} || '%'
          OR coalesce("profileName", '') ILIKE '%' || ${qEsc} || '%'
          OR similarity(coalesce("profileName", ''), ${q}) > 0.3
        ORDER BY similarity(coalesce("profileName", ''), ${q}) DESC, id
        LIMIT 20`;
  return NextResponse.json({ type: "contact", results: rows });
});
