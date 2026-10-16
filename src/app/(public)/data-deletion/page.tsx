// 刪除資料指引 — 公開頁（Meta App Dashboard「User data deletion instructions URL」必填）。
// cwi-legal-20260915 → wa-meta-compliance-20261016 重寫：
//   刪除範圍/備份尾部/審計憑證口徑 = data-deletion.ts 實證行為（e2e M9 全數驗證，mock/local）：
//   單一 transaction 刪晒 Contact 全部 PII（對話/訊息/媒體檔/AI 草稿/病人事實/同意記錄/系統紀錄），
//   預約對賬記錄保留但即時去除個人資訊；備份 ≤30 日尾部；審計只留最小元數據（無訊息原文）。
//   處理時限 30 日（模板 canonical 政策值）。opt-out 短語 = opt-out.ts 詞表實證。
export const metadata = { title: "刪除資料指引 Data Deletion | BACCARAT YL LIMITED" };

export default function DataDeletionPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-[15px] leading-7">
      <h1 className="text-2xl font-semibold">刪除資料指引 Data Deletion Instructions</h1>
      <p className="mt-1 text-sm text-gray-500">生效 Effective：2026-10-01｜最後更新 Last updated：2026-10-16</p>

      {/* ── 中文 ───────────────────────────────────────────── */}
      <section className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold">如何要求刪除你的資料</h2>
        <ol className="list-decimal pl-6 space-y-1">
          <li>電郵至 <b>info@aegisdentalhk.com</b>，主旨註明「刪除個人資料」。</li>
          <li>或致電 <b>+852 6704 5481</b> 於診所營業時間內提出。</li>
          <li>或透過 WhatsApp 向我們發送訊息「刪除我的資料」。</li>
        </ol>
        <p>
          為核實身分，我們可能要求你提供登記時使用的姓名及電話號碼。
          我們會在收到並核實要求後 <b>30 日內</b>由診所職員執行刪除，並向你確認。
        </p>

        <h2 className="text-lg font-semibold">會刪除甚麼</h2>
        <p>經核實後，我們會一次性刪除下列所有關於你的資料：</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>WhatsApp 對話紀錄及全部訊息內容（文字、圖片、語音、文件）。</li>
          <li>對話內的媒體檔案（圖片、語音、文件）。</li>
          <li>人工智能草稿及分析摘要。</li>
          <li>病人事實記錄（例如你告知的偏好、症狀自述）。</li>
          <li>同意及偏好記錄（包括停止聯絡的記錄）。</li>
          <li>與上述對話相關的系統操作紀錄。</li>
        </ul>
        <p className="text-sm text-gray-600">
          與預約對賬相關的記錄（例如已完成的預約時段）會保留，但其中的姓名、電話等個人資訊會同時去除。
        </p>

        <h2 className="text-lg font-semibold">刪除後的限制（請知悉）</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <b>備份</b>：為防止系統故障而做的資料庫備份保留期不超過 30 日。已刪資料可能仍存於尚未過期的備份中，
            至該備份過期後徹底消失。我們不會逐份備份進行選擇性刪除。
          </li>
          <li>
            <b>審計憑證</b>：我們會保留一份最小化的刪除紀錄（刪除時間、經辦職員），
            以便證明你的要求已獲處理；該紀錄不含任何訊息原文或完整電話號碼。
          </li>
          <li>
            <b>診所病歷</b>：由診所按香港法例及牙科專業指引須保留的病歷及診療紀錄，
            不属于本 WhatsApp 系統的刪除範圍；你可向診所另行提出，診所會按法例處理。
          </li>
        </ul>

        <h2 className="text-lg font-semibold">只想停止接收訊息？</h2>
        <p>
          你不需要刪除資料 —— 只需回覆「<b>停止聯絡</b>」、「<b>停止發送</b>」、「<b>不要再發</b>」或「<b>唔好再發</b>」
          （英文：「<b>STOP</b>」、「<b>Stop sending</b>」），我們會即時停止一切主動訊息
          （包括提醒及跟進）並記錄你的選擇；你主動查詢時，我們仍會回覆你。
        </p>

        <h2 className="text-lg font-semibold">聯絡</h2>
        <p>
          資料保障主任 Data Protection Officer<br />
          電郵 Email：info@aegisdentalhk.com<br />
          電話 Tel：+852 6704 5481<br />
          地址 Address：SHOP NO. A306 LEVEL 3 YOHO MALL II, 8 LONG YAT ROAD, YUEN LONG NT, Hong Kong
        </p>
      </section>

      {/* ── English ────────────────────────────────────────── */}
      <section className="mt-12 space-y-4 border-t pt-8">
        <h2 className="text-lg font-semibold">English</h2>

        <h3 className="font-semibold">How to request deletion of your data</h3>
        <ol className="list-decimal pl-6 space-y-1">
          <li>Email <b>info@aegisdentalhk.com</b> with the subject “Data Deletion Request”.</li>
          <li>Call <b>+852 6704 5481</b> during clinic opening hours.</li>
          <li>Send us a WhatsApp message saying “Delete my data”.</li>
        </ol>
        <p>
          To verify your identity, we may ask for your name and registered phone number.
          Verified requests are processed by clinic staff within <b>30 days</b>, and we will confirm
          completion to you.
        </p>

        <h3 className="font-semibold">What we delete</h3>
        <p>Once verified, we delete all of the following about you in a single operation:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Your WhatsApp conversation records and all message content (text, images, audio, documents).</li>
          <li>Media files in the conversation (images, audio, documents).</li>
          <li>AI drafts and analysis summaries.</li>
          <li>Patient fact records (e.g. stated preferences, self-reported symptoms).</li>
          <li>Consent and preference records (including opt-out records).</li>
          <li>System operation records related to the above conversations.</li>
        </ul>
        <p className="text-sm text-gray-600">
          Appointment-reconciliation records (e.g. completed appointment slots) are kept, but the
          personal information in them (names, phone numbers) is removed at the same time.
        </p>

        <h3 className="font-semibold">Limitations after deletion (please note)</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <b>Backups</b>: database backups (for disaster recovery) are retained for no more than 30 days.
            Deleted data may remain in backups that have not yet expired, until those backups expire.
            We do not perform selective deletion inside individual backups.
          </li>
          <li>
            <b>Audit receipt</b>: we keep a minimal deletion record (time of deletion, handling staff)
            to demonstrate that your request was processed. It contains no message content and no full
            phone number.
          </li>
          <li>
            <b>Clinical records</b>: clinical and treatment records that the clinic must retain under
            Hong Kong law and dental professional guidelines are outside the scope of this WhatsApp
            system&apos;s deletion; you may make a separate request to the clinic, which will handle it
            in accordance with the law.
          </li>
        </ul>

        <h3 className="font-semibold">Only want to stop receiving messages?</h3>
        <p>
          You do not need to delete your data — simply reply “<b>STOP</b>” or “<b>Stop sending</b>”
          (or the Chinese equivalents “停止聯絡”, “停止發送”, “不要再發”, “唔好再發”). We will immediately
          stop all proactive messages (including reminders and follow-ups) and record your choice.
          We will still reply when you message us first.
        </p>

        <h3 className="font-semibold">Contact</h3>
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
