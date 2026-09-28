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
    // ★ 審計 B-4：no-unused-vars 對兩個 intentional pattern 放行（唔用逐行 disable）：
    //   - ignoreRestSiblings：`const { passwordHash: _ph, ...safe } = user` — rest destructuring 排除敏感欄（staff routes）
    //   - argsIgnorePattern：`_kind` 等下划線前綴參數 — API 對齊留參（notify-client playChime）
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
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
    // ★ cwi-qa FX-01（workorder 20260928 FX-01 ③ option b）：scripts/**（e2e/unit CLI 測試腳本）
    //   no-explicit-any 降 warn — 85 處全部係測試腳本對 API response / DB row 快速取值（例
    //   `(r.json as any)?.error`），逐一改型對「要繼續 1520/0 全綠」嘅 e2e 代碼風險 > 價值；
    //   src/** 維持 error 唔變（app 代碼標準唔鬆）。
    //   ⚠️ workorder 要求原因記錄喺 docs/decisions/ — 該目錄歸 Lane B（階段 1 並行規則），
    //   本 lane 先記喺 docs/fixplan/cwi-qa-batch-1-report.md + progress（待 Lane B/CEO 補檔）。
    //   降級只限 no-explicit-any — prefer-const / non-null 等其餘規則照常 error。
    files: ["scripts/**/*.{ts,tsx,js,jsx,mjs}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
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
