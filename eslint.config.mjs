import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

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
];

export default eslintConfig;
