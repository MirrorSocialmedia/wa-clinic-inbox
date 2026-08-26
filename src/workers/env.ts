/** worker 入口 env 載入 — Next 只幫 web 載 .env；worker raw tsx 起機要自己載。
 * 用 @next/env（next 自帶，零新依賴）保證 web/worker 讀同一套檔、同一優先序。 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
