import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import noPublishInTransaction from "./eslint-rules/no-publish-in-transaction.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    // ★ M-3（安全審計）：app 代碼（server/worker/lib）禁 console.* — 一律用 pino logger
    //   （log 集中化 + 可被 PII redaction 包住）。scripts/** 係獨立 CLI（stdout 就是輸出協議，
    //   例 e2e/mock-inbound/backup 腳本），唔受此限 — 見交貨報告偏差說明。
    files: ["src/**/*.{ts,tsx,js,jsx,mjs}", "server.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // ★ Realtime P0 (R2, cwi-rt-20260823-a1)：commit-then-emit 鐵律 —
    //   publish 調用永遠唔准喺 $transaction callback 入面（tx 回滾 → 幻影 socket event）。
    //   規則實作：eslint-rules/no-publish-in-transaction.mjs；文檔：src/lib/notify.ts 檔頭。
    files: ["src/**/*.{ts,tsx,js,jsx,mjs}", "server.ts"],
    plugins: {
      local: { rules: { "no-publish-in-transaction": noPublishInTransaction } },
    },
    rules: {
      "local/no-publish-in-transaction": "error",
    },
  },
];

export default eslintConfig;
