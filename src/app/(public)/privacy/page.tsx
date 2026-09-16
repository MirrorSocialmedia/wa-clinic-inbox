// 私隱政策 — 公開頁（Meta App Review 硬性要求）。cwi-legal-20260915。
// 內容 = Kenneth 模板 §① 逐字（iron rule §4 唔准改寫）；保留期 24 個月、伺服器地區「香港」（同 retention-purge default 一致）；
// 公司 4 值 + 生效日期 = PENDING 佔位，S5 老細提供後填。
export const metadata = {
  title: "私隱政策 Privacy Policy | BACCARAT YL LIMITED",
  description: "BACCARAT YL LIMITED WhatsApp 客戶服務系統之個人資料收集及使用聲明",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-[15px] leading-7">
      <h1 className="text-2xl font-semibold">私隱政策 Privacy Policy</h1>
      <p className="mt-1 text-sm text-gray-500">
        生效日期 Effective date：2026-10-01｜最後更新 Last updated：2026-09-16
      </p>

      {/* ── 中文 ───────────────────────────────────────────── */}
      <section className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold">1. 關於我們</h2>
        <p>
          BACCARAT YL LIMITED（下稱「我們」）於香港經營牙科診所，地址：ROOM 1101-02, 11/F OFFICE TOWER WEO GRAND PLAZA, 625 & 639 Nathan Road, Mong Kok, Hong Kong。
          我們透過 WhatsApp 為病人提供查詢、預約及跟進服務。本政策說明我們如何收集、使用、
          儲存及保護你的個人資料，並按照香港《個人資料（私隱）條例》（第486章）行事。
        </p>

        <h2 className="text-lg font-semibold">2. 我們收集甚麼資料</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li><b>WhatsApp 通訊資料</b>：你的 WhatsApp 電話號碼、顯示名稱、你發送給我們的訊息內容（文字、圖片、語音、文件）及發送時間。</li>
          <li><b>預約及診療相關資料</b>：預約日期時間、就診項目、主診醫生、診症記錄、處方及帳單結餘（由我們的診所管理系統提供）。</li>
          <li><b>技術資料</b>：訊息傳送狀態、系統操作紀錄（例如員工何時查閱紀錄）。</li>
        </ul>
        <p className="text-sm text-gray-600">
          我們<b>不會</b>透過 WhatsApp 主動索取身份證號碼、信用卡資料或其他敏感財務資料。
        </p>

        <h2 className="text-lg font-semibold">3. 我們如何使用這些資料</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>回覆你的查詢、安排及確認預約、發出應診提醒。</li>
          <li>治療後跟進、定期覆診提示及帳務提醒。</li>
          <li>將對話分流予合適的同事處理，並在緊急情況下即時轉交人手跟進。</li>
          <li>在人工智能輔助下草擬回覆內容，<b>由診所職員審核後才發送</b>；人工智能不會作出診斷。</li>
          <li>改善服務質素及進行內部培訓（使用去識別化資料）。</li>
        </ul>

        <h2 className="text-lg font-semibold">4. 資料分享</h2>
        <p>我們只在以下情況分享你的資料，並不會出售你的個人資料：</p>
        <ul className="list-disc pl-6 space-y-1">
          <li><b>Meta Platforms（WhatsApp）</b>：訊息經 WhatsApp 傳送，受 Meta 的私隱政策規管。</li>
          <li><b>診所管理系統供應商（Apricot Vita）</b>：用於預約及病歷管理。</li>
          <li><b>法律要求</b>：在法例要求或為保障生命安全的情況下。</li>
        </ul>

        <h2 className="text-lg font-semibold">5. 資料儲存及保留</h2>
        <p>
          資料儲存於位於香港、設有存取控制及加密措施的伺服器。
          WhatsApp 對話紀錄一般保留 24 個月；醫療相關紀錄按適用法例及專業指引保留。
          逾期資料會被刪除或永久去識別化。
        </p>

        <h2 className="text-lg font-semibold">6. 你的權利</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>查閱及要求更正我們持有關於你的個人資料。</li>
          <li>要求刪除你的資料（見 <a className="underline" href="/data-deletion">刪除資料指引</a>）。</li>
          <li><b>停止接收主動訊息</b>：隨時回覆「停止」或「唔好再搵我」，我們會即時將你加入停止聯絡名單；此舉不影響你主動查詢時我們的回覆。</li>
        </ul>

        <h2 className="text-lg font-semibold">7. 兒童</h2>
        <p>未滿 18 歲人士應由家長或監護人代為與我們聯絡。</p>

        <h2 className="text-lg font-semibold">8. 政策更新</h2>
        <p>本政策如有修訂，將於本頁公布並更新「最後更新」日期。</p>

        <h2 className="text-lg font-semibold">9. 聯絡我們</h2>
        <p>
          資料保障主任 Data Protection Officer<br />
          電郵 Email：info@aegisdentalhk.com<br />
          電話 Tel：+852 6704 5481<br />
          地址 Address：ROOM 1101-02, 11/F OFFICE TOWER WEO GRAND PLAZA, 625 & 639 Nathan Road, Mong Kok, Hong Kong
        </p>
      </section>

      {/* ── English ────────────────────────────────────────── */}
      <section className="mt-12 space-y-4 border-t pt-8">
        <h2 className="text-lg font-semibold">English Summary</h2>
        <p>
          BACCARAT YL LIMITED operates dental clinics in Hong Kong and uses WhatsApp to handle patient
          enquiries, appointments and follow-ups. We collect your WhatsApp phone number, display
          name and message content, together with appointment, treatment and billing information
          from our clinic management system.
        </p>
        <p>
          This information is used to respond to enquiries, arrange and confirm appointments, send
          reminders and follow-ups, route conversations to the right staff, and to draft replies
          with AI assistance. <b>AI-generated drafts are reviewed by clinic staff before sending, and
          the AI does not provide diagnoses.</b>
        </p>
        <p>
          We share data only with Meta Platforms (as the WhatsApp service provider), our clinic
          management system provider (Apricot Vita), and where required by law. We do not sell
          personal data. Conversation records are generally retained for 24 months; medical
          records are retained as required by applicable law and professional guidelines.
        </p>
        <p>
          You may request access to, correction or deletion of your data, and may opt out of
          proactive messages at any time by replying “STOP”. See our{" "}
          <a className="underline" href="/data-deletion">data deletion instructions</a>. Contact:{" "}
          info@aegisdentalhk.com.
        </p>
      </section>
    </main>
  );
}
