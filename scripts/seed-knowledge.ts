/**
 * seed-knowledge — Part F（cwi-raggolden-20260904，MD §Part F F.2）知識庫骨架種子。
 *
 * 44 條 = SERVICE×12 + POST_OP×6 + PREP×5 + POLICY×6 + PRICE×10（TKW 一店 — R-1）。
 * 內容係**骨架級**（MD：內容 Kenneth 後填）— 結構完整可運行：每條 SERVICE 有
 * 「係咩、通常幾多次、幾耐、痛唔痛」四要素；PRICE 對應主要 SERVICE + priceMin/Max + disclaimer。
 *
 * R-8 事實鐵律：骨架零實際時段/醫生名/病人記錄 — 只通用描述。
 *
 * 冪等：按 (clinicId, kind, title) 匹配 — 存在 → update（version+1）；唔存在 → create。
 * 用法：pnpm tsx scripts/seed-knowledge.ts [--clinic TKW] [--dry]
 */
import { PrismaClient, Prisma } from "@prisma/client";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch { /* .env 冇就靠 process env */ }

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");
const CLINIC_ARG = (process.argv.find((a) => a.startsWith("--clinic")) ?? "").split("=")[1] ?? "TKW";

interface SeedDoc {
  kind: "SERVICE" | "POST_OP" | "POLICY" | "PRICE" | "PREP" | "FAQ";
  title: string;
  keywords: string[];
  body: string;
  disclaimer?: string;
  priceMin?: number;
  priceMax?: number;
}

const S = (title: string, keywords: string[], body: string): SeedDoc => ({ kind: "SERVICE", title, keywords, body });
const PO = (title: string, keywords: string[], body: string): SeedDoc => ({ kind: "POST_OP", title, keywords, body });
const PR = (title: string, keywords: string[], body: string): SeedDoc => ({ kind: "PREP", title, keywords, body });
const PL = (title: string, keywords: string[], body: string): SeedDoc => ({ kind: "POLICY", title, keywords, body });
const P_ = (title: string, keywords: string[], body: string, priceMin: number, priceMax: number, disclaimer: string): SeedDoc => ({
  kind: "PRICE", title, keywords, body, priceMin, priceMax, disclaimer,
});

const DISCLAIMER = "以上為參考收費範圍，實際費用因應個別情況而定，以到診評估同前台報價為準。";

/** 44 條骨架（TKW；內容骨架級 — Kenneth 後填實際細節）。 */
const SEEDS: SeedDoc[] = [
  // ── SERVICE ×12（每條：係咩、通常幾多次、幾耐、痛唔痛）──────────────────
  S("洗牙", ["洗牙", "潔齒", "潔牙", "洗牙石", "scale", "cleaning"],
    "洗牙係用超聲波同工具清除牙石同牙菌膜，保持口腔衛生。通常 6–12 個月做一次，每趟大約 30–45 分鐘。過程一般唔痛，牙肉敏感嘅人可能微酸，屬正常反應。"),
  S("補牙", ["補牙", "補牙洞", "蛀牙", "齲齒", "填牙", "filling"],
    "補牙係清除蛀損嘅牙質後，用複合樹脂等材料填返牙洞。多數一次搞掂（深嘅蛀牙可能要做多次），每趟約 30–60 分鐘。有麻醉，過程唔會痛；麻醉退後有 1–2 日敏感都屬常見。"),
  S("杜牙根", ["杜牙根", "根管治療", "牙髓治療", "root canal", "杜神经"],
    "杜牙根（牙髓治療）係處理發炎或感染嘅牙神經，清潔牙根管後密封。通常要 1–2 次（根管多嘅臼齒可能多一次），每次約 60–90 分鐘。全程有麻醉，做緊時唔會痛；術後 2–3 日可能有輕微不適。"),
  S("拔牙", ["拔牙", "拔齒", "剝牙", "脫牙", "extraction"],
    "拔牙係將無法保留嘅牙齒完整拔出。多數一次完成，普通前牙約 10–15 分鐘，臼齒稍耐。有麻醉，過程唔會痛；術後 1–3 日可能有輕微腫痛，屬正常。"),
  S("智慧齒", ["智慧齒", "智齒", "wisdom tooth", "最後一隻牙"],
    "智慧齒（智齒）係最後生嘅臼齒，位置唔正或者冇位生時要拔除。簡單嘅一次性拔咗；嵌埋/横長嘅可能要開牙龈，約 30–60 分鐘。有麻醉唔會痛；術後 2–4 日腫痛較明顯，需冰敷同軟食。"),
  S("牙冠", ["牙冠", "牙頂", "鑲牙", "牙套", "cap", "烤瓷"],
    "牙冠係喺受損嚴重嘅牙齒外面套一個「頂」保護。通常要 2 次覆診（第一次預備牙齒做臨時冠，第二次黏正式冠），每次約 30–60 分鐘。預備牙齒時有麻醉；戴正式冠時一般冇痛苦。"),
  S("牙橋", ["牙橋", "橋牙", "bridge"],
    "牙橋係用相鄰幾隻健康牙做「橋墩」，中間架返一隻人工牙，填返缺牙位。通常 2–3 次覆診，每次約 30–60 分鐘。做橋墩牙時有麻醉；完成後飲食功能可大部分恢復。"),
  S("植牙", ["植牙", "牙釘", "種植", "implant"],
    "植牙係喺牙槽骨植入鈦合金牙根，再喺上面裝牙冠，代替失咗嘅牙。全程分 2–3 個階段：植入牙根（約 30–60 分鐘，有麻醉）→ 等骨結合（數星期至數月）→ 裝牙冠。植入時唔會痛；術後數日輕微腫痛屬正常。"),
  S("矯齒", ["矯齒", "箍牙", "cool牙", "戴牙箍", "整牙", "正畸", "aligner"],
    "矯齒係用牙套（傳統金屬/陶瓷或者透明托）逐步調整牙齒排列同咬合。療程通常 1–3 年，每 4–8 星期覆診調整，每次約 15–30 分鐘。調整後 2–3 日有輕微酸軟感，屬正常。"),
  S("美白", ["美白", "牙美白", "漂牙", "整白", "whitening", "漂白"],
    "美白係用專用美白劑提亮牙齒顏色。診所內美白通常一次 60–90 分鐘；家庭美白套裝要每日用數星期。牙齒原本敏感嘅人可能短期酸軟；效果可維持數月至一年以上，視乎飲食習慣。"),
  S("假牙", ["假牙", "義齒", "牙托", "活动假牙", "denture", "假牙床"],
    "假牙係補返多隻缺牙嘅活動裝置。需要印模同多次試戴調整，通常 3–4 次覆診，每次約 30–45 分鐘。初戴 1–2 星期可能有磨擦不適，要返嚟調校到啱止。"),
  S("兒童牙科", ["兒童牙科", "小朋友", "小童", "kid", "兒童塗氟", "防蛀"],
    "兒童牙科涵蓋小童檢查、塗氟、防蛀溝（封口）同基本治療。建議由 1 歲起每年睇 1–2 次，每次約 15–30 分鐘。我哋會用小朋友接受嘅方式溝通，一般唔會有痛苦。"),

  // ── POST_OP ×6 ─────────────────────────────────────────────────────────
  PO("拔牙後護理", ["拔牙後", "拔牙護理", "拔完牙"],
    "拔牙後 30 分鐘咬住棉卷；24 小時內唔好吮吸、吐口水或者用吸管；當日用冷敷減腫；食軟嘅、唔好太熱太辣；一日內唔好刷牙拔牙位，其餘位置照常輕刷。如有劇痛、流血超過一日或者發燒，即刻聯絡我哋。"),
  PO("杜牙根後護理", ["杜牙根後", "杜完牙根", "牙髓治療後"],
    "杜牙根後 2–3 日可能有輕微咬合不適，屬正常；避免用呢隻牙咬硬嘢；照常用溫鹽水漱口保持清潔。如有明顯腫脹超過 3 日、化膿或者持續劇痛，要盡快到診覆查。"),
  PO("洗牙後護理", ["洗牙後", "洗完牙", "洗牙敏感"],
    "洗牙後牙齒可能 1–3 日對冷熱敏感，屬正常，可改用敏感牙膏；牙肉可能輕微出血或鬆弛感，數日內會恢復；照常刷牙漱口即可。敏感持續超過一星期要返嚟覆查。"),
  PO("植牙後護理", ["植牙後", "植入後", "植牙護理"],
    "植牙後 24 小時內避免舔咬植入位；術後 2–3 日輕微腫痛屬正常（按指示用藥）；一星期內食軟食、避免太熱太辣；戒煙至骨結合完成；按時覆診拆線同檢查。如有持續腫痛、發熱或者植入體鬆動，即刻聯絡我哋。"),
  PO("補牙後護理", ["補牙後", "補完牙", "補牙敏感"],
    "補牙後麻醉退前唔好咬嘢（避免咬傷）；複合材料初 24 小時可能對冷熱敏感，屬正常；避免用呢隻牙咬硬殼嘢（堅果殼/瓶蓋）。敏感超過 1–2 星期或者咬落有明顯高低，要返嚟調校。"),
  PO("箍牙調整後護理", ["箍牙調整後", "箍牙後", "矯齒調整", "整牙後"],
    "調整牙絲後 2–3 日牙齒酸軟屬正常，可食軟食；用牙刷+牙縫刷/水牙線清潔托槽周圍；有磨破可以用牙醫蠟包住；托槽脫落要即刻聯絡我哋預約返嚟粘返。"),

  // ── PREP ×5 ────────────────────────────────────────────────────────────
  PR("初診須知", ["初診", "第一次", "首診", "新病人"],
    "第一次到診建議預留 30–60 分鐘（登記+問診+檢查）。建議預約制到診避免等待；如牙痛急性，可以致電前台說明情況，我哋會盡力安排。"),
  PR("帶咩嚟", ["帶咩", "準備咩", "要帶"],
    "請帶同身分證件；如有以往嘅 X 光片或者檢查報告一齊帶嚟，可以慳重複拍攝；服食緊嘅藥物（尤其薄血藥）要主動告知醫生。"),
  PR("X 光同懷孕", ["X光", "拍片", "懷孕", "射線"],
    "我哋會根據需要拍 X 光，並做好防護（鉛衣/領圈）將射線减到最低。如懷孕或者懷疑懷孕，請到診時告知，醫生會視乎情況延遲非必要拍攝或者改用替代檢查。"),
  PR("薄血藥", ["薄血藥", "血藥", "抗凝血", "warfarin", "阿士匹靈"],
    "如服食薄血藥（anticoagulant/抗血小板藥，例如 warfarin、阿士匹靈），到診前請告知醫生同帶上藥物名稱/劑量；拔牙等有創治療前可能需要内科覆核，請預留時間。"),
  PR("小朋友第一次", ["小朋友", "小童", "兒童", "第一次睇牙"],
    "第一次帶小朋友嚟建議由家長陪同；可以預先喺屋企用簡單說話講解流程；到診後医生會用小朋友明白嘅方式溝通，初診一般以觀察同鼓勵為主，建立正向睇牙體驗。"),

  // ── POLICY ×6（唔寫實際時間 — R-8）────────────────────────────────────
  PL("改期/取消政策", ["改期", "取消", "取消預約", "改約"],
    "改期或取消預約請提前至少一星期知會我哋，以便將時段讓畀其他病人；臨時取消多次會影響日後預約優先。直接覆訊息或者致電前台都可以。"),
  PL("遲到政策", ["遲到", "遲咗", "失約"],
    "請按預約時間到診；遲到超過 15 分鐘，當次時段可能保留而你需要等候，或者需要重新預約。如預咗會遲到，請即時致電前台通知我哋。"),
  PL("付款方式", ["付款", "交费", "how to pay", "pay"],
    "我哋接受現金、轉數快、信用卡/拍卡等常見付款方式（以前台公佈為準）。費用一般於服務完成後即場繳付。"),
  PL("保險/收據", ["保險", "收據", "invoice", "報銷"],
    "可以出具正式收據（電子或紙本）供保險索償或報銷；私營保險索償一般需要診斷證明書同明細單，到前台交代辦要求即可。"),
  PL("交通/泊車", ["交通", "泊車", "parking", "地鐵"],
    "診所位置同交通方式可以到店後向前台查詢，前台可以提供最近港鐵站/巴士站路線指引同泊車建議。"),
  PL("營業時間政策", ["營業時間", "幾時開", "開門", "關門"],
    "營業時間以診所前台公佈及預約系統顯示為準（假日安排可能調整）；建議預約制到診，急症情況請致電前台。"),

  // ── PRICE ×10（對應主要 SERVICE + priceMin/Max + disclaimer 必填 — R-2）─
  P_("洗牙收費", ["洗牙", "潔齒", "洗牙幾錢", "潔齒幾錢"],
    "影響因素：牙石多寡同牙肉狀況會影響時間同價格。", 600, 1200, DISCLAIMER),
  P_("補牙收費", ["補牙", "蛀牙", "齲齒"],
    "影響因素：蛀損位置（前牙/臼齒）同深淺、材料選擇。", 400, 1500, DISCLAIMER),
  P_("杜牙根收費", ["杜牙根", "根管治療"],
    "影響因素：牙位（前牙/臼齒）、根管數目同難度、有冇感染。", 1500, 3500, DISCLAIMER),
  P_("拔牙收費", ["拔牙", "剝牙", "脫牙"],
    "影響因素：牙位、拔除難度（普通/阻生）。", 300, 1500, DISCLAIMER),
  P_("智慧齒收費", ["智慧齒", "智齒"],
    "影響因素：嵌埋程度、位置、有無感染（嵌埋/横長價高）。", 800, 4000, DISCLAIMER),
  P_("牙冠收費", ["牙冠", "牙頂", "鑲牙"],
    "影響因素：材料（烤瓷/全瓷）、牙位。", 2500, 6000, DISCLAIMER),
  P_("植牙收費", ["植牙", "牙釘幾錢"],
    "影響因素：種植體品牌、有冇要補骨、牙冠材料。", 8000, 20000, DISCLAIMER),
  P_("矯齒收費", ["矯齒", "箍牙", "cool牙", "整牙"],
    "影響因素：方式（傳統/陶瓷/透明托）、療程難度同長期。", 20000, 60000, DISCLAIMER),
  P_("美白收費", ["美白", "漂牙", "整白"],
    "影響因素：方式（診所內一次性/家庭套裝）。", 1500, 5000, DISCLAIMER),
  P_("假牙收費", ["假牙", "義齒", "牙托"],
    "影響因素：缺牙數目、材料、係局部定全口。", 1500, 12000, DISCLAIMER),
];

async function main(): Promise<void> {
  const clinic = await prisma.clinic.findUnique({ where: { code: CLINIC_ARG } });
  if (!clinic) {
    console.error(`clinic ${CLINIC_ARG} 搵唔到`);
    process.exit(1);
  }
  let created = 0;
  let updated = 0;
  for (const s of SEEDS) {
    const existing = await prisma.knowledgeDoc.findFirst({
      where: { clinicId: clinic.id, kind: s.kind, title: s.title },
    });
    if (existing) {
      if (!DRY) {
        await prisma.knowledgeDoc.update({
          where: { id: existing.id },
          data: {
            keywords: s.keywords,
            body: s.body,
            disclaimer: s.disclaimer ?? null,
            priceMin: s.priceMin ?? null,
            priceMax: s.priceMax ?? null,
            version: { increment: 1 },
            updatedBy: "seed-knowledge",
          },
        });
      }
      updated += 1;
      continue;
    }
    if (DRY) {
      created += 1;
      continue;
    }
    await prisma.knowledgeDoc.create({
      data: {
        clinicId: clinic.id,
        kind: s.kind as Prisma.KnowledgeDocCreateInput["kind"],
        title: s.title,
        keywords: s.keywords,
        body: s.body,
        disclaimer: s.disclaimer ?? null,
        priceMin: s.priceMin ?? null,
        priceMax: s.priceMax ?? null,
        enabled: true,
        version: 1,
        updatedBy: "seed-knowledge",
      },
    });
    created += 1;
  }
  console.log(`seed-knowledge [${CLINIC_ARG}]: total=${SEEDS.length} created=${created} updated=${updated}${DRY ? " (dry)" : ""}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
