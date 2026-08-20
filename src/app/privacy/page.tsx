/**
 * /privacy — 私隱政策（Meta App Review 硬性要求 #1/#2）。
 *
 * - 公開頁：無 auth、唔經 (admin) route group、唔進 RBAC — 任何人（包括無 cookie
 *   嘅無痕瀏覽器）都讀得到。static server component（無 session/headers 依賴 → 預渲染）。
 * - 第 9 條 `id="deletion"` — App Dashboard「User data deletion instructions URL」
 *   指去 `https://wa.<域名>/privacy#deletion`。
 * - 全文照 App Review MD §1.2（書面語版）。★ 方括號 = 出街前必填（老細/律師確認）；
 *   第 6 條保留期已拍板：對話 24 個月 / 媒體 12 個月（要同（將來）retention cron 一致）。
 * - PII：本頁純文案，零病人/職員數據。
 */
export const metadata = { title: "私隱政策 Privacy Policy — WA Clinic Inbox" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-[15px] leading-7">
      <h1 className="text-2xl font-bold">私隱政策 Privacy Policy</h1>
      <p className="mt-2 text-t2">最後更新日期 Last updated: [日期]</p>

      <section className="mt-8">
        <h2>1. 關於我們 Who we are</h2>
        <p>
          本系統（「WA Clinic Inbox」）由 [公司名稱] 受 [診所集團名稱]（「本診所」）委託開發及營運，用於處理病人透過
          WhatsApp 發送之查詢及預約請求。
        </p>
        <p lang="en">
          This system (&quot;WA Clinic Inbox&quot;) is a WhatsApp customer service platform operated by [Your Company] on
          behalf of [Clinic Group Name] (the &quot;Clinic&quot;) to handle patient enquiries and appointment requests sent
          via WhatsApp.
        </p>
      </section>

      <section className="mt-8">
        <h2>2. 收集之資料 Data we collect</h2>
        <p>
          當閣下透過 WhatsApp 與本診所聯絡，本系統會接收並儲存：閣下之 WhatsApp 號碼及顯示名稱；閣下發送之訊息內容（包括文字、圖片、文件及語音）；以及閣下經互動表單提交之預約資料（所選醫生、日期及時間）。本系統不會收集閣下
          WhatsApp 帳戶之任何其他資料。
        </p>
        <p lang="en">
          When you contact the Clinic via WhatsApp, we receive and store: your WhatsApp number and display name;
          the content of messages you send (text, images, documents, voice notes); and appointment details you
          submit through interactive forms (chosen practitioner, date and time). We do not collect any other data
          from your WhatsApp account.
        </p>
      </section>

      <section className="mt-8">
        <h2>3. 資料用途 How we use your data</h2>
        <p>
          閣下之資料僅用於回覆查詢、協調預約，以及向閣下發送與診症相關之通知（例如預約確認）。我們不會將閣下之資料用於廣告用途，亦絕不向任何第三方出售或出租閣下之資料。
        </p>
        <p lang="en">
          Your data is used only to respond to your enquiries, coordinate appointments, and send you care-related
          notifications (such as booking confirmations). We do not use your data for advertising and never sell or
          rent it to any third party.
        </p>
      </section>

      <section className="mt-8">
        <h2>4. 人工智能輔助 AI assistance</h2>
        <p>
          本診所使用人工智能（AI）輔助回覆：AI 會為職員草擬回覆建議，經職員審閱後方會發出；部分常見查詢可能收到由本診所牙科醫生預先審核之自動回覆（並會清楚標示）。所有
          AI 處理均於我們自行管理之系統內進行，閣下之訊息不會傳送予任何第三方 AI 服務。重要事項一概以職員確認為準。
        </p>
        <p lang="en">
          We use AI to assist our team: AI drafts suggested replies which our staff review before sending; some
          common enquiries may receive automated replies pre-approved by our dentists (clearly indicated as such).
          All AI processing takes place within systems we operate — your messages are never sent to any third-party
          AI service. Important matters are always confirmed by our staff.
        </p>
      </section>

      <section className="mt-8">
        <h2>5. 儲存與保安 Storage and security</h2>
        <p>
          資料儲存於我們管理、位於 [伺服器地區] 之加密伺服器。保安措施包括：靜態加密、傳輸加密（TLS）、按診所劃分之職員存取權限、管理員雙重認證及存取記錄。WhatsApp
          訊息於傳送過程中由 Meta 按其私隱政策處理。
        </p>
        <p lang="en">
          Data is stored on encrypted servers we manage in [region]. Safeguards include encryption at rest,
          encryption in transit (TLS), per-clinic staff access controls, two-factor authentication for
          administrators, and access logging. WhatsApp messages in transit are handled by Meta under its own
          privacy policy.
        </p>
      </section>

      <section className="mt-8">
        <h2>6. 保留期限 Retention</h2>
        <p>
          對話記錄保留 24 個月，媒體檔案保留 12 個月，期滿自動刪除。閣下可隨時要求提前刪除（見第 8 條）。
        </p>
        <p lang="en">
          Conversation records are retained for 24 months and media files for 12 months, after which they are
          deleted automatically. You may request earlier deletion at any time (see section 8).
        </p>
      </section>

      <section className="mt-8">
        <h2>7. 第三方 Third parties</h2>
        <p>
          訊息經 Meta（WhatsApp）平台傳送。除 Meta 作為通訊渠道外，我們不會向任何第三方披露閣下之資料，惟法律要求者除外。
        </p>
        <p lang="en">
          Messages are delivered through Meta&apos;s WhatsApp platform. Other than Meta as the messaging channel,
          we do not disclose your data to any third party unless required by law.
        </p>
      </section>

      <section className="mt-8">
        <h2>8. 閣下之權利 Your rights</h2>
        <p>
          根據香港《個人資料（私隱）條例》，閣下有權查閱及改正我們所持有關於閣下之個人資料，或要求刪除閣下之對話記錄。請電郵至 [privacy@域名]
          或於 WhatsApp 向職員提出，我們將於 [40 日] 內處理。
        </p>
        <p lang="en">
          Under the Hong Kong Personal Data (Privacy) Ordinance, you may request access to or correction of your
          personal data held by us, or request deletion of your conversation records. Please email
          [privacy@yourdomain] or ask our staff on WhatsApp; we will respond within [40 days].
        </p>
      </section>

      {/* ★ id="deletion" — App Dashboard「User data deletion instructions URL」anchor */}
      <section id="deletion" className="mt-8 scroll-mt-6">
        <h2>9. 資料刪除指示 Data deletion instructions</h2>
        <p>
          如欲要求刪除閣下之全部資料，請電郵至 [privacy@域名]
          並註明閣下之 WhatsApp 號碼。我們將刪除閣下之聯絡人資料、全部對話記錄、媒體檔案及預約請求，並於完成後通知閣下。
        </p>
        <p lang="en">
          To request deletion of all your data, email [privacy@yourdomain] stating your WhatsApp number. We will
          delete your contact record, all conversation history, media files and appointment requests, and confirm
          once complete.
        </p>
      </section>

      <section className="mt-8">
        <h2>10. 查詢 Contact</h2>
        <p>
          [公司名稱]，電郵 Email：[email]。
        </p>
      </section>
    </main>
  );
}
