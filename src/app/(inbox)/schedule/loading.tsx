import { WLoading } from "@/components/ui/w-loader";

/**
 * ★ cwi-mobile-ux-20261018：醫生時間表載入（server 要問 clinic-workforce 1–3 秒）— 頁面級 W。
 * 上／下週、週日切換係 <a href> 真導航，揀店係 router.replace — 兩者都等 server render，以前呢段時間乜都冇顯示。
 */
export default function Loading() {
  return (
    <div className="flex-1 flex items-center justify-center min-h-[50vh]">
      <WLoading size="page" label="載入緊時間表…" />
    </div>
  );
}
