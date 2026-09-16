// 服務條款 — 公開頁（Meta App Review 用）。cwi-legal-20260915。
// 內容 = Kenneth 模板 §② 逐字（iron rule §4 唔准改寫）；公司 4 值 + 生效日期 = PENDING 佔位，S5 老細提供後填。
export const metadata = { title: "服務條款 Terms of Service | BACCARAT YL LIMITED" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-[15px] leading-7">
      <h1 className="text-2xl font-semibold">服務條款 Terms of Service</h1>
      <p className="mt-1 text-sm text-gray-500">生效日期：2026-10-01</p>

      <section className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold">1. 服務範圍</h2>
        <p>
          我們透過 WhatsApp 提供查詢回覆、預約安排、應診提醒及治療後跟進。
          本服務<b>並非緊急醫療服務</b>。如遇緊急情況（例如面部腫脹、流血不止、呼吸困難、
          吞嚥困難或高燒），請立即致電診所或前往急症室。
        </p>

        <h2 className="text-lg font-semibold">2. 非診斷聲明</h2>
        <p>
          透過 WhatsApp 提供的資訊<b>不構成診斷或治療建議</b>。任何治療方案、收費及
          適用性均須由註冊牙科醫生親自檢查後確定。所報價格為一般參考範圍，
          實際費用以到診評估後的書面報價為準。
        </p>

        <h2 className="text-lg font-semibold">3. 人工智能輔助</h2>
        <p>
          我們使用人工智能協助草擬回覆。所有內容於發送前均由診所職員審核。
          人工智能不會作出診斷，亦不會在未經職員確認下承諾任何治療結果或時間。
        </p>

        <h2 className="text-lg font-semibold">4. 訊息及預約</h2>
        <p>
          我們會在診所營業時間內盡快回覆。預約以診所系統確認為準；
          如需取消或更改，請提前通知。重複缺席可能影響日後預約安排。
        </p>

        <h2 className="text-lg font-semibold">5. 你的責任</h2>
        <p>
          請提供準確資料，並只就本人或你有權代表的人士與我們聯絡。
          請勿透過 WhatsApp 傳送與診療無關的敏感資料。
        </p>

        <h2 className="text-lg font-semibold">6. 停止接收訊息</h2>
        <p>你可隨時回覆「停止」以停止接收主動訊息。</p>

        <h2 className="text-lg font-semibold">7. 條款修訂</h2>
        <p>我們可能不時修訂本條款，修訂後將於本頁公布。</p>

        <h2 className="text-lg font-semibold">8. 聯絡</h2>
        <p>info@aegisdentalhk.com｜+852 6704 5481｜ROOM 1101-02, 11/F OFFICE TOWER WEO GRAND PLAZA, 625 & 639 Nathan Road, Mong Kok, Hong Kong</p>
      </section>

      <section className="mt-12 space-y-4 border-t pt-8">
        <h2 className="text-lg font-semibold">English Summary</h2>
        <p>
          We provide enquiry handling, appointment scheduling, reminders and follow-up via WhatsApp.
          <b> This is not an emergency service</b> — in an emergency, call the clinic or attend an
          A&E department. Information provided via WhatsApp <b>does not constitute a diagnosis</b>;
          treatment plans and fees are confirmed only after in-person examination by a registered
          dentist. AI assists in drafting replies; all messages are reviewed by clinic staff before
          sending. You may opt out of proactive messages at any time by replying “STOP”.
        </p>
      </section>
    </main>
  );
}
