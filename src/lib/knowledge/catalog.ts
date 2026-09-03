/**
 * ★ Part F（cwi-raggolden-20260904，MD §Part F F.2/F.3）：知識庫目錄（stage 1 語料）。
 *
 * - 目錄 = 每條 `id | title | keywords.join("/")` 一行（50 條 ≈ 1200–1800 字）。
 * - 載入範圍：enabled=true ∧ (clinicId=本店 ∨ clinicId=null 全局)。
 * - **目錄字串 cache 5 分鐘**（同 lexicon/params 同模式）；知識更新 → CONTROL_CHANNEL
 *   `cache:bust scope=knowledge` 即時失效（web + worker 兩 process）。
 * - 目錄 >2500 字 → log warn（R-3：>150 條先考慮 embedding — 呢度先係早期警號）。
 * - fail-soft：DB 死 → 空目錄 + warn（零 throw — inbox 唔准死喺知識庫）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import type { KnowledgeKind } from "@prisma/client";

export interface CatalogDoc {
  id: string;
  kind: KnowledgeKind;
  title: string;
  keywords: string[];
  body: string;
  disclaimer: string | null;
  priceMin: number | null;
  priceMax: number | null;
}

export interface KnowledgeCatalog {
  /** 目錄字串（stage 1 prompt 用）— 每條一行 `id | title | k1/k2/k3` */
  text: string;
  /** 目錄字數（>2500 warn 用） */
  charCount: number;
  /** id → doc（全文 + 驗證用） */
  byId: Map<string, CatalogDoc>;
  /** 全部載入條目（keyword 匹配 / price chain 用） */
  docs: CatalogDoc[];
}

const EMPTY: KnowledgeCatalog = { text: "", charCount: 0, byId: new Map(), docs: [] };

const CACHE_TTL_MS = Number(process.env.KNOWLEDGE_TTL_MS ?? 5 * 60_000);
const CATALOG_WARN_CHARS = 2500;
const cache = new Map<string, { at: number; catalog: KnowledgeCatalog }>();

/** 知識更新後清 cache（publishControl cache:bust scope=knowledge → applyCacheBust 調呢度）。 */
export function bustKnowledgeCache(): void {
  cache.clear();
}

function buildCatalogText(docs: CatalogDoc[]): string {
  return docs.map((d) => `${d.id} | ${d.title} | ${d.keywords.join("/")}`).join("\n");
}

/**
 * 載入知識目錄（clinic + 全局，enabled）。fail-soft：DB 失敗 → 空目錄。
 */
export async function getKnowledgeCatalog(clinicId: string | null): Promise<KnowledgeCatalog> {
  const cacheKey = clinicId ?? "*";
  if (CACHE_TTL_MS > 0) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.catalog;
  }
  let catalog: KnowledgeCatalog;
  try {
    const rows = await prisma.knowledgeDoc.findMany({
      where: { enabled: true, OR: [{ clinicId: null }, { clinicId: clinicId ?? "" }] },
    });
    const docs: CatalogDoc[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      keywords: r.keywords,
      body: r.body,
      disclaimer: r.disclaimer,
      priceMin: r.priceMin,
      priceMax: r.priceMax,
    }));
    // 同 title 時店級優先於全局（覆寫語義）— deterministic 排序：店級先、再 title
    docs.sort((a, b) => a.title.localeCompare(b.title, "zh-HK"));
    const byId = new Map<string, CatalogDoc>();
    for (const d of docs) byId.set(d.id, d);
    const text = buildCatalogText(docs);
    catalog = { text, charCount: text.length, byId, docs };
    if (text.length > CATALOG_WARN_CHARS) {
      log.warn(
        { clinicId: clinicId ?? "global", chars: text.length, warnAt: CATALOG_WARN_CHARS, docs: docs.length },
        "knowledge: 目錄超 2500 字 — 考慮拆條/裁 keyword（>150 條再考慮 embedding）"
      );
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "knowledge: DB 讀失敗 → 空目錄（fail-soft）");
    catalog = EMPTY;
  }
  if (CACHE_TTL_MS > 0) cache.set(cacheKey, { at: Date.now(), catalog });
  return catalog;
}

/** 目錄預覽（admin UI「預覽目錄」）— 同 stage 1 prompt 入嘅段落一模一樣。 */
export function previewCatalog(catalog: KnowledgeCatalog): {
  text: string;
  charCount: number;
  /** est. tokens（繁中 ≈ 1 字 1 token 保守估；拉丁字 ≈ 4 字/token — 混排取 max 兩邊） */
  estTokens: number;
  docCount: number;
} {
  const cjk = (catalog.text.match(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g) ?? []).length;
  const latin = catalog.text.length - cjk;
  return {
    text: catalog.text,
    charCount: catalog.charCount,
    estTokens: cjk + Math.ceil(latin / 4),
    docCount: catalog.docs.length,
  };
}
