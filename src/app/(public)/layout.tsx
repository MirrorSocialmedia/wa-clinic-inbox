// (public) group layout — 公開法律頁（Meta 商家驗證用，cwi-legal-20260915）。
// 極簡 layout：唔 import inbox 側欄／socket／session hook；無任何 client-side auth。
// MD §1.1 逐字，兩處機械修正（錄 progress）：footer /data-deletion（MD typo 下劃線）+ © 2026 年份實值。
// ★ cwi-ux UX-06：footer 改用共用 LegalLinks（同 login/account/admin 同一組 link）；
//   robots 明確 index/follow（Meta 爬蟲要睇到法律頁；其他頁維持現行狀態）。
import { LegalLinks } from "@/components/legal-links";

export const metadata = {
  robots: { index: true, follow: true },
};

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="border-b px-6 py-4">
        <span className="text-sm font-semibold">BACCARAT YL LIMITED</span>
      </header>
      {children}
      <footer className="mt-16 border-t px-6 py-8 text-xs text-gray-500">
        <LegalLinks />
        <p className="mt-2">© 2026 BACCARAT YL LIMITED</p>
      </footer>
    </div>
  );
}
