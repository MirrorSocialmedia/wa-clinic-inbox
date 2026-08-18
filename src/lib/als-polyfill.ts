/**
 * AsyncLocalStorage polyfill — 必須喺 server.ts 第一行 import（任何 next import 之前）。
 *
 * 原因：Next 15 嘅 `app-render/async-local-storage.js` 喺 module load 時 capture
 * `globalThis.AsyncLocalStorage`（const），而 Next 自己係由 `node-environment-baseline.js`
 * 先 set 呢個 global — 正常 CJS 順序下 baseline 會先跑。但 tsx（dev/worker 嘅
 * require 環境）會改變 require 順序，令 async-local-storage.js 先 load →
 * capture undefined → FakeAsyncLocalStorage → 任何 route render 都 throw
 * "Invariant: AsyncLocalStorage accessed in runtime where it is not available"。
 *
 * 修法：喺任何 next module load 之前自己 set 好呢個 global（用 Node 原生實現，
 * 同 Next baseline 做嘅一模一樣）。生產 node（無 tsx）執行時 baseline 本來就 work，
 * 呢度 set 一次幂等、零副作用。
 */
import { AsyncLocalStorage } from "node:async_hooks";

if (typeof globalThis.AsyncLocalStorage !== "function") {
  (globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage =
    AsyncLocalStorage;
}
