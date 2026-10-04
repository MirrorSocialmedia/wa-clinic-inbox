/**
 * cwi-labdoc-extract — Lab 單據讀取 prompt（施工單 cwm-labdoc §5.3）。
 *
 * ★ 契約檔：呢份文字同 CWM repo（apps/web/src/lib/labdoc/prompt.ts）必須逐字一致。
 *   防漂移：test/fixtures/labdoc/prompt.v1.txt 係 byte-identical 副本，
 *   scripts/unit-labdoc-extract.ts 斷言兩者一致；CWM P2 用同一份 fixture 對比。
 *   改文字要兩邊同步 + 更新 fixture（同一個 PR）。
 *
 * 最後一行 {labHint} 係佔位行：
 *   - labHint 有值（LabProfile.extractionHint，已識別 Lab 時）→ 佔位行替換成 hint 文字（trim，cap 500 字）
 *   - labHint = null（第一次讀未知 Lab）→ 整行移除
 * 兩邊 repo 必須用同一個 buildLabDocPrompt 語義（見下）。
 */
export const LABDOC_EXTRACT_PROMPT = `你係牙科 Lab 單據讀取器。只輸出一個 JSON 物件，唔好輸出任何其他文字。
規則：
1. 判斷文件類型：INVOICE（單張發票／送貨單）或 STATEMENT（月結單、產品結算表、Outstanding Statement，列出多張發票）。
2. 只抄印出嘅內容；手寫字、圈號、簽名、剔號唔好讀。讀唔到填 null，唔好估。
   例外：Lab 名被切，但頁面其他地方（底部條款、印章、email 網域）印咗全名，可以用，並喺 readIssues 寫明出處。
3. 金額輸出數字（唔要 $、HK$、逗號）；貸項／CREDIT 用負數。日期一律 YYYY-MM-DD，原文放 dateRaw。
4. 病人：姓名抄到 patientNameRaw；病人編號抄到 patientCodeRaw，連字母前綴一齊抄（例「TY9845」）；
   Lab 自己嘅編號（例 DT9003874、Case No.、7 位 Lab 編號）抄到 labCaseRef，唔好當病人編號。
5. 同一病人嘅行放同一個 group。
6. 絕對唔好抄：銀行名之後嘅帳號、Account No.、Swift、FPS ID、支票號碼、支票底部 MICR 數字、簽名。
   如果頁面有支票，readIssues 加 "CHEQUE_PRESENT"。
7. 有「List Price」「D/C %」「U'Price」→ amount 用實際收費欄；D/C % 原文抄 discountRaw。
8. 文件打橫或倒轉都照讀。
9. STATEMENT：
   a. 每個「診所＋醫生」係一個 section（例如每頁一個醫生）；抄 clinicRaw、doctorRaw、customerNoRaw、section 總數。
   b. INVOICE# 空白嘅行沿用上一個單號。
   c. 每行抄晒有嘅欄：單號、日期、病人、項目、牙位、數量、單價、金額。
   d. 用「本行金額」欄，唔好用累計結餘（BALANCE）欄。
   e. 有分齡欄（Current Mth／31-90 days 等）就喺 agingBucket 填 CURRENT／D31_90／D91_365／OVER_1Y。
   f. 付款、承上結餘、服務費行要標 lineType（PAYMENT／BF／CHARGE）。
{labHint}
`;

const HINT_RE = /\{labHint\}\n?$/;
export const LABDOC_MAX_HINT_CHARS = 500;

/**
 * labHint 有值 → 佔位行替換成 hint（trim、cap 500 字）；null/空白 → 佔位行整行移除。
 * 決定性語義：CWM 側必須逐字 mirror（fixture + 單測锁定）。
 */
export function buildLabDocPrompt(labHint: string | null): string {
  if (labHint == null || labHint.trim() === "") {
    return LABDOC_EXTRACT_PROMPT.replace(HINT_RE, "");
  }
  const hint = labHint.trim().slice(0, LABDOC_MAX_HINT_CHARS);
  return LABDOC_EXTRACT_PROMPT.replace(HINT_RE, hint + "\n");
}
