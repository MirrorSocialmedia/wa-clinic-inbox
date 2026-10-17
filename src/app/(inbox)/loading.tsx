import { WLoading } from "@/components/ui/w-loader";

/** ★ cwi-inbox-r4：轉頁／首次載入 — 頁面級 W（綠底方塊，同 app icon）。 */
export default function Loading() {
  return (
    <div className="flex-1 flex items-center justify-center min-h-[50vh]">
      <WLoading size="page" label="載入中…" />
    </div>
  );
}
