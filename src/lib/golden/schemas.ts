/**
 * ★ Part F（cwi-raggolden-20260904，F.5）：GoldenCase zod schemas。
 *
 * 放 lib/ 而唔係 route module — Next App Router 嘅 route.ts 淨可 export handler +
 * 特定 config keys（.next/types 強制檢查），zod schema 必須放隔離（[id] route 共用）。
 */
import { z } from "zod";
import { AI_INTENTS } from "@/lib/ai/types";

const INTENTS = AI_INTENTS;

export const createGoldenSchema = z.object({
  clinicId: z.string().min(1),
  utterance: z.string().min(1).max(2000),
  contextBefore: z.array(z.string().max(2000)).max(2).default([]),
  expectIntent: z.enum(INTENTS),
  expectRedFlag: z.boolean().default(false),
  expectAutoOk: z.boolean().default(false),
  expectDocIds: z.array(z.string().min(1)).max(10).default([]),
  note: z.string().max(500).nullable().optional(),
});

export const updateGoldenSchema = createGoldenSchema
  .omit({ clinicId: true })
  .partial()
  .extend({ enabled: z.boolean().optional() });
