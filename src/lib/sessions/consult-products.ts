/**
 * ★ consult v2.1 C2（MD §3 鐵律）：ConsultProduct 詞表 — iron rule helper + admin CRUD zod schemas。
 *
 * 鐵律（MD §3）：`approvedAt == null` 或 `enabled == false` 嘅產品，
 * **唔准出現喺任何 AI 草稿或檢索結果**。
 *   → C3 檢索 / C4 生成一律經 isProductUsable 過濾；本檔 helper 係單一來源。
 *
 * isProductUsable 入參 = Prisma ConsultProduct row（只靠 enabled/approvedAt 兩欄 —
 *   任何 shape 有呢兩欄嘅 object 都適用，唔強綁 Prisma type）。
 */
import { z } from "zod";
import { CONSULT_WORKFLOWS, ORTHO_CATEGORIES } from "@/lib/sessions/consult-types";

/** 鐵律：產品有冇資格進入任何 AI 草稿或檢索。null/undefined approvedAt = 未批准 = 唔 usable。 */
export function isProductUsable(p: { enabled: boolean; approvedAt: Date | string | null | undefined }): boolean {
  return p.enabled && p.approvedAt != null;
}

// ── admin CRUD zod（POST 全量 / PUT 增量；clinicId null = 全局） ─────────

const workflowSchema = z.enum(CONSULT_WORKFLOWS);
// category：箍牙兩類 + IMPLANT（MD §3 ConsultProduct.category 註）
const categorySchema = z.enum([...ORTHO_CATEGORIES, "IMPLANT"] as const).nullable().optional();

/** 共用欄位（POST 必填口径；PUT 當增量 base）。 */
const productBase = {
  clinicId: z.string().min(1).nullable(),
  workflow: workflowSchema,
  code: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  category: categorySchema,
  brand: z.string().max(120).nullable().optional(),
  productFamily: z.string().max(120).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  material: z.string().max(120).nullable().optional(),
  surface: z.string().max(120).nullable().optional(),
  positioning: z.string().min(1),                       // 呢個方案係咩（L2/L3）— 必填
  approvedWording: z.string().min(1),                    // ★ 可以照講嘅句子 — 必填（無 approved 詞就唔好落）
  avoidPhrases: z.array(z.string().min(1)).default([]),  // ★ 唔准講
  timeWording: z.string().nullable().optional(),         // 療程時間點講（留空 = 唔准講時間）
  packageNote: z.string().nullable().optional(),
  warrantyNote: z.string().nullable().optional(),
  priceDocTitle: z.string().min(1).nullable().optional(), // 對應 KnowledgeDoc(kind=PRICE).title
  sortOrder: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  approvedBy: z.string().min(1).nullable().optional(),
  approvedAt: z.coerce.date().nullable().optional(),     // 批准時間（null = 未批准 → 唔 usable）
};

/** POST /api/admin/consult-products — 新增產品。 */
export const consultProductCreateSchema = z.object(productBase);
export type ConsultProductCreateInput = z.infer<typeof consultProductCreateSchema>;

/** PUT /api/admin/consult-products/:id — 增量更新（未提供欄位保持原值）。 */
export const consultProductUpdateSchema = z.object({
  clinicId: z.string().min(1).nullable().optional(),
  workflow: workflowSchema.optional(),
  code: z.string().min(1).max(64).optional(),
  displayName: z.string().min(1).max(120).optional(),
  category: categorySchema,
  brand: z.string().max(120).nullable().optional(),
  productFamily: z.string().max(120).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  material: z.string().max(120).nullable().optional(),
  surface: z.string().max(120).nullable().optional(),
  positioning: z.string().min(1).optional(),
  approvedWording: z.string().min(1).optional(),
  avoidPhrases: z.array(z.string().min(1)).optional(),
  timeWording: z.string().nullable().optional(),
  packageNote: z.string().nullable().optional(),
  warrantyNote: z.string().nullable().optional(),
  priceDocTitle: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
  approvedBy: z.string().min(1).nullable().optional(),
  approvedAt: z.coerce.date().nullable().optional(),
});
export type ConsultProductUpdateInput = z.infer<typeof consultProductUpdateSchema>;
