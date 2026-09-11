/**
 * ★ consult v2.1 C4（MD §7）：內容 seed（出廠，醫生可改）+ CTA baseline。
 *
 * - §7.1 箍牙三條 ConsultProduct：TRAD（FIXED）/ IGO + IFULL（CLEAR_ALIGNER）
 *   — displayName/positioning/approvedWording/timeWording/avoidPhrases 照 MD §7.1 表**逐字**。
 *   `priceDocTitle` = 「箍牙（矯齒）收費」；**seed 時 `approvedAt = null`**（等醫生喺 UI 確認 —
 *   鐵律：unapproved 產品唔准入 prompt/草稿/search）。
 * - §7.2 植牙佔位兩條：HIOSSEN_PENDING / STRAUMANN_PENDING（`enabled = false`）。
 * - §7.3 / §7.2 CTA baseline（出廠 — 醫生可改；mock ASK_FOR_CONSULTATION 逐字用；C5 UI 預覽同源）。
 *
 * scope 口徑：seed = **global（clinicId=null）出廠 row** — 所有店 inherit；per-clinic 覆寫
 * （UI 複製/修改）= C5 範圍。matchNamedProduct/prompt 檢索已支持 clinicId null（C2/C3 鐵律路徑）。
 * 冪等：find-first-by(workflow, code, clinicId=null) → 已存在 skip（唔 clobber 醫生改動）。
 *
 * MD §7.1 表未指定 brand/model 欄 → CTO judgment（醫生 UI 可改）：
 * IGO/IFULL brand="Invisalign" model="I GO"/"I Full"；TRAD brand=null。
 */
import type { PrismaClient } from "@prisma/client";
import log from "@/lib/log";

/** MD §7.1 逐字：priceDocTitle 對應 KnowledgeDoc(kind=PRICE).title。 */
export const ORTHO_PRICE_DOC_TITLE = "箍牙（矯齒）收費";

/** MD §7.3 / §7.2 逐字：CTA baseline（出廠，醫生可改）。 */
export const CONSULT_CTA_BASELINE = {
  ORTHODONTIC_CONSULT: "如果你想準確知道邊款適合你，可以先做一次矯齒評估☺️ 要唔要我幫你睇下預約時間？",
  IMPLANT_CONSULT: "植牙方案要睇返骨量同口腔情況，可以先做一次評估☺️ 要唔要我幫你睇下時間？",
} as const;

/** seed row shape（= admin CRUD 同一份欄；clinicId 固定 null = global 出廠）。 */
export interface ConsultProductSeed {
  clinicId: null;
  workflow: "ORTHODONTIC_CONSULT" | "IMPLANT_CONSULT";
  code: string;
  displayName: string;
  category: string;
  brand: string | null;
  productFamily: string | null;
  model: string | null;
  material: string | null;
  surface: string | null;
  positioning: string;
  approvedWording: string;
  avoidPhrases: string[];
  timeWording: string | null;
  packageNote: string | null;
  warrantyNote: string | null;
  priceDocTitle: string | null;
  sortOrder: number;
  enabled: boolean;
  approvedBy: string | null;
  approvedAt: null; // ★ MD §7：seed 時永遠 null（等醫生確認）
}

// ── §7.1 箍牙三條（MD 表逐字） ─────────────────────────────────────────

export const ORTHO_PRODUCT_SEEDS: ConsultProductSeed[] = [
  {
    clinicId: null,
    workflow: "ORTHODONTIC_CONSULT",
    code: "TRAD",
    displayName: "傳統固定牙箍",
    category: "FIXED",
    brand: null,
    productFamily: "傳統牙箍",
    model: null,
    material: null,
    surface: null,
    positioning: "固定式、金屬托槽、外觀較明顯、可處理廣泛排列／咬合問題",
    approvedWording: "傳統固定牙箍可以處理比較廣泛嘅牙齒排列同咬合問題，不過外觀會相對明顯。",
    timeWording: "療程時間會因個案而不同，常見大約一年至兩年左右，複雜個案可能更長。",
    avoidPhrases: ["所有複雜個案一定要傳統", "控制力一定係三種之中最好", "你一定適合傳統"],
    priceDocTitle: ORTHO_PRICE_DOC_TITLE,
    sortOrder: 1,
    enabled: true,
    approvedBy: null,
    approvedAt: null,
    packageNote: null,
    warrantyNote: null,
  },
  {
    clinicId: null,
    workflow: "ORTHODONTIC_CONSULT",
    code: "IGO",
    displayName: "Invisalign I GO",
    category: "CLEAR_ALIGNER",
    brand: "Invisalign",
    productFamily: "隱形牙箍",
    model: "I GO",
    material: null,
    surface: null,
    positioning: "針對較簡單至中度牙齒移動、透明較不顯眼",
    approvedWording: "I GO 主要針對較簡單至中度嘅牙齒移動，透明相對冇咁顯眼。",
    timeWording: "有啲 I GO 個案最快可以約 6 個月。",
    avoidPhrases: ["你想快所以 I GO 最適合你", "你一定半年完成", "I GO 所有人都可以做", "一般 6–9 個月"],
    priceDocTitle: ORTHO_PRICE_DOC_TITLE,
    sortOrder: 2,
    enabled: true,
    approvedBy: null,
    approvedAt: null,
    packageNote: null,
    warrantyNote: null,
  },
  {
    clinicId: null,
    workflow: "ORTHODONTIC_CONSULT",
    code: "IFULL",
    displayName: "完整 Invisalign",
    category: "CLEAR_ALIGNER",
    brand: "Invisalign",
    productFamily: "隱形牙箍",
    model: "I Full",
    material: null,
    surface: null,
    positioning: "更全面、可涵蓋較廣泛牙齒移動及部分咬合修正、透明",
    approvedWording: "完整 Invisalign 可以處理更廣泛嘅情況，包括整個牙弓同部分咬合修正。",
    timeWording: "平均大約 12–18 個月，實際仍由主診醫生按個案決定。",
    avoidPhrases: ["I Full 一定適合複雜個案", "I Full 一定好過 I GO", "一定需要 12–18 個月"],
    priceDocTitle: ORTHO_PRICE_DOC_TITLE,
    sortOrder: 3,
    enabled: true,
    approvedBy: null,
    approvedAt: null,
    packageNote: null,
    warrantyNote: null,
  },
];

// ── §7.2 植牙佔位兩條（enabled=false — 未有型號資料） ─────────────────

const IMPLANT_PENDING_WORDING = (brand: string) =>
  `${brand} 有唔同植體型號同材料，實際用邊款要按醫生對你個案嘅評估決定。`;

export const IMPLANT_PRODUCT_SEEDS: ConsultProductSeed[] = [
  {
    clinicId: null,
    workflow: "IMPLANT_CONSULT",
    code: "HIOSSEN_PENDING",
    displayName: "Hiossen 植體（待確認）",
    category: "IMPLANT",
    brand: "Hiossen",
    productFamily: "植體",
    model: null,
    material: null,
    surface: null,
    positioning: "植體方案（型號資料待醫生補充）",
    approvedWording: IMPLANT_PENDING_WORDING("Hiossen"),
    timeWording: null,
    avoidPhrases: [],
    priceDocTitle: null,
    sortOrder: 1,
    enabled: false,
    approvedBy: null,
    approvedAt: null,
    packageNote: null,
    warrantyNote: null,
  },
  {
    clinicId: null,
    workflow: "IMPLANT_CONSULT",
    code: "STRAUMANN_PENDING",
    displayName: "Straumann 植體（待確認）",
    category: "IMPLANT",
    brand: "Straumann",
    productFamily: "植體",
    model: null,
    material: null,
    surface: null,
    positioning: "植體方案（型號資料待醫生補充）",
    approvedWording: IMPLANT_PENDING_WORDING("Straumann"),
    timeWording: null,
    avoidPhrases: [],
    priceDocTitle: null,
    sortOrder: 2,
    enabled: false,
    approvedBy: null,
    approvedAt: null,
    packageNote: null,
    warrantyNote: null,
  },
];

export const CONSULT_PRODUCT_SEEDS: ConsultProductSeed[] = [...ORTHO_PRODUCT_SEEDS, ...IMPLANT_PRODUCT_SEEDS];

// ── 冪等 seed ─────────────────────────────────────────────────────────

export interface SeedConsultContentResult {
  created: number;
  skipped: number;
  codes: string[];
}

/**
 * 出廠 seed（冪等 — 重跑唔重複；已存在 skip = 醫生改動唔 clobber）。
 * 冚家：5 條（3 箍牙 approvedAt=null + 2 植牙 enabled=false）。
 */
export async function seedConsultContent(prisma: PrismaClient): Promise<SeedConsultContentResult> {
  const out: SeedConsultContentResult = { created: 0, skipped: 0, codes: [] };
  for (const seed of CONSULT_PRODUCT_SEEDS) {
    const existing = await prisma.consultProduct.findFirst({
      where: { workflow: seed.workflow, code: seed.code, clinicId: null },
      select: { id: true },
    });
    if (existing) {
      out.skipped += 1;
      continue;
    }
    await prisma.consultProduct.create({ data: seed });
    out.created += 1;
    out.codes.push(seed.code);
  }
  if (out.created > 0) log.info({ created: out.created, codes: out.codes }, "consult-content: seed done");
  return out;
}
