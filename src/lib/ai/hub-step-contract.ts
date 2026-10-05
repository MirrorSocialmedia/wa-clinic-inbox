/**
 * cwi-setnav SET-05/07：AI 流程七步契約 — 純常量單一來源（client/server 共用，零依賴）。
 *
 * 舊版喺 hub-summary.ts（server 模組 — 帶 prisma/redis，client 無法 import）。
 * 抽出原因：
 * - SET-05：第 ⑤ 步要加第二條連結「技能組」（STEP_EXTRA_LINKS）— hub 頁 + 路由規則頁頂共用。
 * - SET-07：ADMIN 側欄「AI」組可摺疊子項（AI_NAV_SUBITEMS）— href 全部讀自呢份契約，
 *   唔好兩份清單（工單明令）。
 *
 * hub-summary.ts 保留 re-export HUB_STEP_CONTRACT（unit-hub-b / e2e-hub-b 斷言口徑不變）。
 */

export const STEP_NAMES = ["安全閘", "理解", "對話模式", "搵資料", "派俾邊個", "出文", "發唔發"] as const;
export const STEP_ANCHORS = [
  "/admin/workflows#wf-pain-triage", // ① 紅旗區（pain-triage 卡）
  "/admin/ai/keywords", // ② 關鍵詞中心
  "/admin/consult", // ③ AI 傾偈設定
  "/admin/knowledge", // ④ 知識庫
  "/admin/routing-rules", // ⑤ 路由規則
  "/admin/workflows#wf-tone", // ⑥ tone 新區（唯讀 guard 清單）
  "/admin/automation", // ⑦ AI 自動化
] as const;

/** 七步契約（name + anchor）— unit/e2e 斷言用單一來源（T360/T368）。 */
export const HUB_STEP_CONTRACT: ReadonlyArray<readonly [string, string]> = [
  [STEP_NAMES[0], STEP_ANCHORS[0]],
  [STEP_NAMES[1], STEP_ANCHORS[1]],
  [STEP_NAMES[2], STEP_ANCHORS[2]],
  [STEP_NAMES[3], STEP_ANCHORS[3]],
  [STEP_NAMES[4], STEP_ANCHORS[4]],
  [STEP_NAMES[5], STEP_ANCHORS[5]],
  [STEP_NAMES[6], STEP_ANCHORS[6]],
];

/**
 * 第 ⑤ 步「派俾邊個」額外加鏈（cwi-setnav SET-05：技能組入口）。
 * 索引 = step（0-based）；空陣列 = 冇額外加鏈。
 */
export const STEP_EXTRA_LINKS: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [],
  [],
  [],
  [],
  [
    ["技能組", "/admin/skill-groups"],
  ],
  [],
  [],
];

/**
 * cwi-setnav SET-07：ADMIN 側欄「AI」組可摺疊子項。
 * label = 工單定字（紅旗／關鍵詞／傾偈設定／知識庫／路由規則／技能組／自動化）；
 * href 全部讀自 HUB_STEP_CONTRACT / STEP_EXTRA_LINKS（同一份清單 — 唔好兩份）。
 * 第 ⑥ 步「出文」不入側欄子項（workflows 頁已有獨立入口；① 紅旗喺度出現一次就夠）。
 */
export const AI_NAV_SUBITEMS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "紅旗", href: STEP_ANCHORS[0] },
  { label: "關鍵詞", href: STEP_ANCHORS[1] },
  { label: "傾偈設定", href: STEP_ANCHORS[2] },
  { label: "知識庫", href: STEP_ANCHORS[3] },
  { label: "路由規則", href: STEP_ANCHORS[4] },
  { label: "技能組", href: STEP_EXTRA_LINKS[4][0][1] },
  { label: "自動化", href: STEP_ANCHORS[6] },
];
