/**
 * ★ Part F（cwi-raggolden-20260904，F.2）：KnowledgeDoc zod schema + 知識 cache bust。
 *
 * 放 lib/ 而唔係 route module — Next App Router 嘅 route.ts 淨可 export handler +
 * 特定 config keys（.next/types 強制檢查），zod schema / helper 必須放隔離。
 */
import { z } from "zod";
import { bustKnowledgeCache } from "@/lib/knowledge/catalog";
import { publishControl } from "@/lib/notify";

export const KNOWLEDGE_KINDS = ["SERVICE", "POST_OP", "POLICY", "PRICE", "PREP", "FAQ"] as const;

/** 知識條目 zod schema（R-2：PRICE 必填 disclaimer ≥8 + priceMin <= priceMax）。 */
export const knowledgeDocSchema = z
  .object({
    clinicId: z.string().min(1).nullable(),
    kind: z.enum(KNOWLEDGE_KINDS),
    title: z.string().min(1).max(120),
    keywords: z.array(z.string().min(1).max(40)).min(1).max(20),
    body: z.string().min(1).max(1200), // MD: ≤600 字 — 1200 char hard cap 防 prompt 爆
    disclaimer: z.string().max(300).nullable(),
    priceMin: z.number().int().positive().nullable(),
    priceMax: z.number().int().positive().nullable(),
    enabled: z.boolean().optional(),
  })
  .refine((d) => d.kind !== "PRICE" || (d.disclaimer !== null && d.disclaimer.trim().length >= 8), {
    message: "PRICE 條目 disclaimer 必填（長度 ≥8）",
    path: ["disclaimer"],
  })
  .refine((d) => d.kind !== "PRICE" || (d.priceMin !== null && d.priceMax !== null), {
    message: "PRICE 條目 priceMin/priceMax 必填",
    path: ["priceMin"],
  })
  .refine((d) => d.kind !== "PRICE" || (d.priceMin !== null && d.priceMax !== null && d.priceMin <= d.priceMax), {
    message: "priceMin 必須 <= priceMax",
    path: ["priceMin"],
  });

export type KnowledgeDocInput = z.infer<typeof knowledgeDocSchema>;

/** 知識更新後：local cache bust + 跨 process CONTROL_CHANNEL（worker 側 applyCacheBust 處理）。 */
export function bustKnowledgeAfterChange(): void {
  bustKnowledgeCache();
  publishControl({ cmd: "cache:bust", scope: "knowledge" });
}
