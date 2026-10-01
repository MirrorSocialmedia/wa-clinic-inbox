/**
 * LegalLinks — 法律頁共用入口（cwi-ux UX-06：Meta 審核用私隱政策喺 app 搵唔到）。
 *
 * 用點（同一組 link 唔好三處各寫）：
 * - /login 底部（未登入就見到）
 * - /account 帳戶卡下方
 * - /admin 側欄底部
 * - (public) 法律頁 footer（互相 link）
 *
 * isomorphic（冇 hook / 冇 client state）— server component 同 client component 都用得。
 * 用原生 <a>（同頁導航；spec：target 同頁，唔開新 tab）。
 */
export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 ${className}`} aria-label="法律頁面">
      <a href="/privacy" className="underline underline-offset-2 hover:opacity-75">
        私隱政策
      </a>
      <span aria-hidden className="opacity-60">
        ·
      </span>
      <a href="/terms" className="underline underline-offset-2 hover:opacity-75">
        服務條款
      </a>
      <span aria-hidden className="opacity-60">
        ·
      </span>
      <a href="/data-deletion" className="underline underline-offset-2 hover:opacity-75">
        刪除資料
      </a>
    </nav>
  );
}
