// 私隱政策 — 公開頁（Meta App Review 硬性要求）。cwi-legal-20260915 → wa-meta-compliance-20261016 重寫。
// 口徑鐵律：每項聲稱都實證咗代碼行為先寫（工單 A）：
//   - AI DRAFT/AUTO 雙模式（auto-send-gate.ts 實證：AUTO 店會自動發，DRAFT 店留 staff 審批）
//   - 保留期 = retention-policy 常數單一來源（24 月對話 / 12 月媒體，boot assertion 強制 env 一致）
//   - opt-out 短語 = opt-out.ts 詞表實證（「停止」兩字单独唔喺詞表 — 文案只列真實有效短語）
//   - 診所管理系統只提供 availability / providers / appointments（workforce 同步實證；
//     代碼無處方/帳單同步 → 舊文案「處方及帳單結餘」已刪）
//   - AI 推理 = 自營運 OpenAI-compatible endpoint（vllm.ts 實證；代碼庫無任何訓練/微調路徑）
// 公司法定 4 值 = 老細提供值保留（人工確認清單項目 — 未改）。
import { POLICY_RETENTION_MONTHS, POLICY_RETENTION_MEDIA_MONTHS } from "@/lib/ops/retention-policy";
export const metadata = {
  title: "私隱政策 Privacy Policy | BACCARAT YL LIMITED",
  description: "BACCARAT YL LIMITED WhatsApp 客戶服務系統之個人資料收集及使用聲明",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-[15px] leading-7">
      <h1 className="text-2xl font-semibold">私隱政策 Privacy Policy</h1>
      <p className="mt-1 text-sm text-gray-500">
        生效日期 Effective date：2026-10-01｜最後更新 Last updated：2026-10-16
      </p>

      {/* ── 中文（完整版）────────────────────────────────────────── */}
      <section className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold">1. 關於我們</h2>
        <p>
          BACCARAT YL LIMITED（下稱「我們」）於香港經營牙科診所，地址：SHOP NO. A306 LEVEL 3 YOHO MALL II, 8 LONG YAT ROAD, YUEN LONG NT, Hong Kong。
          我們透過 WhatsApp Business 為病人提供查詢、預約及跟進服務。本政策說明我們如何收集、使用、
          儲存及保護你的個人資料，並按照香港《個人資料（私隱）條例》（第486章）行事。
        </p>

        <h2 className="text-lg font-semibold">2. 我們收集甚麼資料</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li><b>WhatsApp 通訊資料</b>：你的 WhatsApp 電話號碼、顯示名稱、你發送給我們的訊息內容（文字、圖片、語音、文件）及發送時間。</li>
          <li><b>預約相關資料</b>：預約日期時間、主診醫生、診症時段（由我們的診所管理系統提供，僅用於展示及預約流程）。</li>
          <li><b>同意及偏好記錄</b>：你同意或拒絕接收主動訊息的記錄（包括來源、時間及用途）。</li>
          <li><b>技術資料</b>：訊息傳送狀態、系統操作紀錄（例如員工何時查閱紀錄）。</li>
        </ul>
        <p className="text-sm text-gray-600">
          我們<b>不會</b>透過 WhatsApp 主動索取身份證號碼、信用卡資料或其他敏感財務資料。
        </p>

        <h2 className="text-lg font-semibold">3. 我們如何使用這些資料</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>回覆你的查詢、安排及確認預約、發出應診提醒。</li>
          <li>治療後跟進、定期覆診提示（可隨時停止，見第 6 節）。</li>
          <li>將對話分流予合適的同事處理；偵測到緊急情況時即時轉交人手跟進。</li>
          <li>
            <b>人工智能輔助</b>：我們使用人工智能分析訊息及草擬回覆。人工智能<b>不會作出診斷</b>，
            其輸出只限於回覆草擬及分類。按診所設定，回覆以兩種模式之一處理：
            <ul className="mt-1 list-circle pl-5 space-y-1">
              <li><b>草稿模式</b>：人工智能草擬的回覆須由診所職員審核後才會發送。</li>
              <li><b>自動模式</b>：人工智能的回覆可自動發送，但僅限你主動訊息後 24 小時內的普通查詢回覆；
              涉及緊急情況、投訴、或你明確要求人手處理時，一律轉由職員處理而不會自動發送。</li>
            </ul>
          </li>
          <li>
            <b>人工智能資料使用聲明</b>：
            <ul className="mt-1 list-circle pl-5 space-y-1">
              <li>你的訊息內容僅用於讓人工智能理解你的查詢並生成回覆，不會用於訓練或微調任何人工智能模型。</li>
              <li>人工智能推理於我們自行營運的伺服器上進行，不會將你的資料傳送予第三方雲端人工智能服務。</li>
              <li>內部服務質素檢討只使用去識別化摘要（不含姓名、電話等可識別資料）。</li>
            </ul>
          </li>
        </ul>

        <h2 className="text-lg font-semibold">4. 資料分享</h2>
        <p>我們只在以下情況處理或分享你的資料，並不會出售你的個人資料：</p>
        <ul className="list-disc pl-6 space-y-1">
          <li><b>Meta Platforms（WhatsApp）</b>：訊息經 WhatsApp 傳送，相關處理受 Meta 的私隱政策規管。</li>
          <li><b>診所管理系統</b>：為顯示預約及診症時段，我們從你所在診所運用的診所管理系統取得預約及醫生資訊；該系統僅取得必要的預約資料。</li>
          <li><b>我們的伺服器</b>：你的對話資料儲存於我們自行營運的伺服器（用於本服務功能，包括第 3 節所述人工智能分析）。</li>
          <li><b>法律要求</b>：在法例要求或為保障生命安全的情況下。</li>
        </ul>

        <h2 className="text-lg font-semibold">5. 資料儲存及保留</h2>
        <p>
          我們的伺服器位於香港，設有存取控制及加密措施；第三方服務供應商（如 Meta）可能於香港以外處理資料。
          保留期限如下，逾期資料會被刪除或永久去識別化：
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>WhatsApp 對話紀錄：<b>{POLICY_RETENTION_MONTHS} 個月</b>（自最後一次訊息起計）。</li>
          <li>對話內媒體檔案（圖片、語音、文件）：<b>{POLICY_RETENTION_MEDIA_MONTHS} 個月</b>。</li>
          <li>人工智能草稿（未採用）：90 日。</li>
          <li>系統審計紀錄：12 至 24 個月（只含操作元數據，不含訊息原文）。</li>
        </ul>
        <p>
          資料庫備份（用於故障恢復）保留期不超過 30 日。如你要求刪除資料，已刪資料可能仍存於尚未過期的備份中，
          至該備份過期後徹底消失。醫療相關紀錄由診所按適用法例及專業指引另行保留。
        </p>

        <h2 className="text-lg font-semibold">6. 你的權利</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li><b>查閱及更正</b>：要求查閱或更正我們持有關於你的個人資料，請聯絡第 9 節所列資料保障主任。</li>
          <li><b>刪除</b>：要求刪除你的資料（見 <a className="underline" href="/data-deletion">刪除資料指引</a>）。</li>
          <li>
            <b>停止接收主動訊息</b>：隨時回覆「停止聯絡」、「停止發送」、「不要再發」或「唔好再發」
            （英文：「STOP」、「Stop sending」），我們會即時停止向你發送任何主動訊息
            （包括提醒及跟進），並記錄你的選擇；此舉不影響你主動查詢時我們的回覆。
            如你日後改變主意，回覆「可以繼續發」（英文：「Please contact me again」）
            或聯絡我們職員並說明用途，即可恢復接收。
          </li>
          <li>
            <b>要求真人處理</b>：回覆「我要同職員傾」或「我要真人」（英文：「Talk to a human」），
            人工智能將停止自動回覆該對話，由診所職員接手處理。
          </li>
        </ul>

        <h2 className="text-lg font-semibold">7. 訊息發送規則（24 小時窗口）</h2>
        <p>
          根據 WhatsApp 政策，你發送訊息後 24 小時內，我們可以直接回覆；24 小時後，
          我們只能發送經 WhatsApp 審批的預設訊息（例如預約提醒）。所有主動發送的訊息
          （包括系統自動發送的提醒）均遵守第 6 節的停止聯絡規則。
        </p>

        <h2 className="text-lg font-semibold">8. 兒童</h2>
        <p>未滿 18 歲人士應由家長或監護人代為與我們聯絡。</p>

        <h2 className="text-lg font-semibold">9. 政策更新</h2>
        <p>本政策如有修訂，將於本頁公布並更新「最後更新」日期。</p>

        <h2 className="text-lg font-semibold">10. 聯絡我們</h2>
        <p>
          資料保障主任 Data Protection Officer<br />
          電郵 Email：info@aegisdentalhk.com<br />
          電話 Tel：+852 6704 5481<br />
          地址 Address：SHOP NO. A306 LEVEL 3 YOHO MALL II, 8 LONG YAT ROAD, YUEN LONG NT, Hong Kong
        </p>
      </section>

      {/* ── English（完整版）────────────────────────────────────── */}
      <section className="mt-12 space-y-4 border-t pt-8">
        <h2 className="text-lg font-semibold">English — Privacy Policy (Full)</h2>

        <h3 className="font-semibold">1. About us</h3>
        <p>
          BACCARAT YL LIMITED (the “Clinic”) operates dental clinics in Hong Kong at
          SHOP NO. A306 LEVEL 3 YOHO MALL II, 8 LONG YAT ROAD, YUEN LONG NT, Hong Kong.
          We use WhatsApp Business to handle patient enquiries, appointments and follow-ups.
          This policy explains how we collect, use, store and protect your personal data,
          in accordance with the Personal Data (Privacy) Ordinance (Cap. 486) of Hong Kong.
        </p>

        <h3 className="font-semibold">2. Data we collect</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li><b>WhatsApp communication data</b>: your WhatsApp phone number, display name, the content of messages you send us (text, images, audio, documents) and timestamps.</li>
          <li><b>Appointment data</b>: appointment dates/times, provider and session slots, obtained from your clinic&apos;s management system solely for display and the booking flow.</li>
          <li><b>Consent and preference records</b>: your opt-in or opt-out choices for proactive messaging, including source, time and purpose.</li>
          <li><b>Technical data</b>: message delivery status and system operation logs (e.g. when staff view records).</li>
        </ul>
        <p className="text-sm text-gray-600">
          We do <b>not</b> request identity card numbers, credit card details or other sensitive
          financial data over WhatsApp.
        </p>

        <h3 className="font-semibold">3. How we use your data</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li>To respond to enquiries, arrange and confirm appointments, and send appointment reminders.</li>
          <li>For post-treatment follow-ups and review prompts (you may opt out at any time — see section 6).</li>
          <li>To route conversations to the appropriate staff; when an urgent situation is detected, the conversation is escalated to staff immediately.</li>
          <li>
            <b>Artificial intelligence assistance</b>: we use AI to analyse messages and draft replies.
            The AI <b>does not provide medical diagnoses</b>; its output is limited to reply drafts
            and classification. Depending on the clinic&apos;s configuration, replies are handled in one of two modes:
            <ul className="mt-1 list-circle pl-5 space-y-1">
              <li><b>Draft mode</b>: AI-drafted replies are reviewed by clinic staff before being sent.</li>
              <li><b>Automatic mode</b>: AI replies may be sent automatically, but only for ordinary enquiry
              replies within 24 hours after your message. Emergencies, complaints, or any explicit request for
              a human are always routed to staff and never sent automatically.</li>
            </ul>
          </li>
          <li>
            <b>AI data-use statement</b>:
            <ul className="mt-1 list-circle pl-5 space-y-1">
              <li>Your message content is used only so that the AI can understand your enquiry and generate a reply. It is <b>not</b> used to train or fine-tune any AI model.</li>
              <li>AI inference runs on servers we operate ourselves. Your data is not sent to any third-party cloud AI service.</li>
              <li>Internal quality reviews use de-identified summaries only (no names, phone numbers or other identifiers).</li>
            </ul>
          </li>
        </ul>

        <h3 className="font-semibold">4. Data sharing</h3>
        <p>We process or share your data only in the following circumstances, and we do not sell personal data:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li><b>Meta Platforms (WhatsApp)</b>: messages are delivered via WhatsApp; related processing is governed by Meta&apos;s privacy policy.</li>
          <li><b>Clinic management system</b>: to display appointments and session slots, we retrieve appointment and provider information from the management system used by your clinic; only the necessary appointment data is accessed.</li>
          <li><b>Our servers</b>: your conversation data is stored on servers we operate, for the purposes of this service (including the AI analysis described in section 3).</li>
          <li><b>Legal requirement</b>: where required by law or to protect life or safety.</li>
        </ul>

        <h3 className="font-semibold">5. Storage and retention</h3>
        <p>
          Our servers are located in Hong Kong, with access controls and encryption; third-party
          service providers (such as Meta) may process data outside Hong Kong. Retention periods are:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>WhatsApp conversation records: <b>{POLICY_RETENTION_MONTHS} months</b> (from the last message).</li>
          <li>Media files within conversations (images, audio, documents): <b>{POLICY_RETENTION_MEDIA_MONTHS} months</b>.</li>
          <li>Unused AI drafts: 90 days.</li>
          <li>System audit logs: 12–24 months (operation metadata only, no message content).</li>
        </ul>
        <p>
          Database backups (for disaster recovery) are retained for no more than 30 days. If you request
          deletion, deleted data may remain in backups that have not yet expired, until those backups expire.
          Medical records are retained separately by the clinic as required by applicable law and professional guidelines.
        </p>

        <h3 className="font-semibold">6. Your rights</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li><b>Access and correction</b>: request access to, or correction of, your personal data by contacting the Data Protection Officer in section 10.</li>
          <li><b>Deletion</b>: request deletion of your data (see our <a className="underline" href="/data-deletion">data deletion instructions</a>).</li>
          <li>
            <b>Opt out of proactive messages</b>: at any time, reply “STOP”, “Stop sending”,
            or the Chinese equivalents “停止聯絡”, “停止發送”, “不要再發”, “唔好再發”. We will immediately
            stop sending you any proactive messages (including reminders and follow-ups) and record your choice.
            This does not affect your ability to message us first and receive replies.
            To re-subscribe later, reply “Please contact me again” (or “可以繼續發”) or contact our staff
            and state the purpose.
          </li>
          <li>
            <b>Request a human</b>: reply “Talk to a human” (or “我要同職員傾”, “我要真人”). The AI will stop
            replying automatically in that conversation and clinic staff will take over.
          </li>
        </ul>

        <h3 className="font-semibold">7. Message sending rules (24-hour window)</h3>
        <p>
          Under WhatsApp&apos;s policy, we may reply directly within 24 hours after you message us.
          After 24 hours, we can only send pre-approved message templates (e.g. appointment reminders).
          All proactive messages, including system-sent reminders, are subject to the opt-out rules in section 6.
        </p>

        <h3 className="font-semibold">8. Children</h3>
        <p>Persons under 18 should contact us through a parent or guardian.</p>

        <h3 className="font-semibold">9. Policy updates</h3>
        <p>Any changes to this policy will be published on this page with an updated “Last updated” date.</p>

        <h3 className="font-semibold">10. Contact us</h3>
        <p>
          Data Protection Officer<br />
          Email: info@aegisdentalhk.com<br />
          Tel: +852 6704 5481<br />
          Address: SHOP NO. A306 LEVEL 3 YOHO MALL II, 8 LONG YAT ROAD, YUEN LONG NT, Hong Kong
        </p>
      </section>
    </main>
  );
}
