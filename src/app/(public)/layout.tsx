// (public) group layout — 公開法律頁（Meta 商家驗證用，cwi-legal-20260915）。
// 極簡 layout：唔 import inbox 側欄／socket／session hook；無任何 client-side auth。
// MD §1.1 逐字，兩處機械修正（錄 progress）：footer /data-deletion（MD typo 下劃線）+ © 2026 年份實值。
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="border-b px-6 py-4">
        <span className="text-sm font-semibold">⟨公司名稱⟩</span>
      </header>
      {children}
      <footer className="mt-16 border-t px-6 py-8 text-xs text-gray-500">
        <nav className="flex gap-4">
          <a className="underline" href="/privacy">私隱政策</a>
          <a className="underline" href="/terms">服務條款</a>
          <a className="underline" href="/data-deletion">刪除資料</a>
        </nav>
        <p className="mt-2">© 2026 ⟨公司名稱⟩</p>
      </footer>
    </div>
  );
}
