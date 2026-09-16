// 刪除資料指引 — 公開頁（Meta App Dashboard「User data deletion instructions URL」必填）。cwi-legal-20260915。
// 內容 = Kenneth 模板 §③ 逐字（iron rule §4 唔准改寫）；處理時限 30 日（模板 canonical 政策值）；
// 公司 4 值 + 最後更新日期 = PENDING 佔位，S5 老細提供後填。
export const metadata = { title: "刪除資料指引 Data Deletion | BACCARAT YL LIMITED" };

export default function DataDeletionPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-[15px] leading-7">
      <h1 className="text-2xl font-semibold">刪除資料指引 Data Deletion Instructions</h1>
      <p className="mt-1 text-sm text-gray-500">最後更新：2026-09-16</p>

      <section className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold">如何要求刪除你的資料</h2>
        <ol className="list-decimal pl-6 space-y-1">
          <li>電郵至 <b>info@aegisdentalhk.com</b>，主旨註明「刪除個人資料」。</li>
          <li>或致電 <b>+852 6704 5481</b> 於診所營業時間內提出。</li>
          <li>或透過 WhatsApp 向我們發送訊息「刪除我的資料」。</li>
        </ol>
        <p>
          為核實身分，我們可能要求你提供登記時使用的姓名及電話號碼。
          我們會在收到並核實要求後 <b>30 日內</b>處理。
        </p>

        <h2 className="text-lg font-semibold">會刪除甚麼</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>WhatsApp 對話紀錄及相關訊息內容。</li>
          <li>用於跟進提醒的聯絡紀錄。</li>
        </ul>

        <h2 className="text-lg font-semibold">可能無法刪除的部分</h2>
        <p>
          按照香港法例及牙科專業指引，<b>病歷及診療紀錄須保留指定年期</b>，
          於該期間內我們無法刪除該等紀錄，但會限制其使用範圍。
          已完成之帳務紀錄亦須按稅務及會計要求保留。
        </p>

        <h2 className="text-lg font-semibold">只想停止接收訊息？</h2>
        <p>
          你不需要刪除資料 —— 只需回覆「<b>停止</b>」或「唔好再搵我」，
          我們會即時停止一切主動訊息，但仍會在你主動查詢時回覆你。
        </p>

        <h2 className="text-lg font-semibold">聯絡</h2>
        <p>info@aegisdentalhk.com｜+852 6704 5481｜ROOM 1101-02, 11/F OFFICE TOWER WEO GRAND PLAZA, 625 & 639 Nathan Road, Mong Kok, Hong Kong</p>
      </section>

      <section className="mt-12 space-y-4 border-t pt-8">
        <h2 className="text-lg font-semibold">English</h2>
        <p>
          To request deletion of your data, email <b>info@aegisdentalhk.com</b> with the subject
          “Data Deletion Request”, call <b>+852 6704 5481</b>, or send us a WhatsApp message
          saying “Delete my data”. We may ask you to verify your name and registered phone number,
          and will process verified requests within <b>30 days</b>.
        </p>
        <p>
          We will delete your WhatsApp conversation records and follow-up contact records.{" "}
          <b>Clinical and billing records must be retained</b> for the periods required by Hong Kong
          law and dental professional guidelines; during that period we restrict their use rather
          than delete them. If you only wish to stop receiving proactive messages, simply reply
          “STOP”.
        </p>
      </section>
    </main>
  );
}
