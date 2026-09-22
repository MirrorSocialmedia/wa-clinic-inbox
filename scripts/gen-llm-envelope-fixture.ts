/**
 * gen-llm-envelope-fixture — cwi-final S2-9 信封 test vector 生成器
 *
 * 用**固定測試 key** seal 一個信封 → 寫 test/fixtures/llm-envelope.v1.json。
 * C6 會喺 workforce repo（apps/web）放同一份 fixture + 同一份 llm-envelope.ts，
 * 兩邊 unit test 都要 `open` 得返原文 — 邊邊 envelope 實作漂移（HKDF salt / AAD 格式 / GCM 參數）
 * 都會令對邊 open 失敗。
 *
 * 用法（repo root）：pnpm -s tsx scripts/gen-llm-envelope-fixture.ts
 *
 * ★ 呢個 secret 只係 test vector（公開咗喺兩個 repo）— 唔係生產密鑰。
 *   生產密鑰 = openssl rand -base64 48，入兩邊 server .env（NEVER commit）。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seal, REQ_CONTEXT } from "../src/lib/internal/llm-envelope";

// 固定測試 key（48 bytes — 滿足 >= 32 bytes 驗證；內容咁樣排係為咗肉眼可讀 + 無意義）
export const TEST_SECRET_B64 = Buffer.from("cwi-s29a-test-key-0000000000000000000000000001").toString("base64");

const KID = "k1";

// body = 模擬 workforce 报价請求（零 PII — 純 fixture 文字）
const BODY = {
  notePlain: "fixture note（S2-9 test vector — 非真病人資料）：A1 做咗，B2 未做。",
  terms: [
    { shorthand: "A1", nameCn: "測試項目A", nameEn: "Test A" },
    { shorthand: "B2", nameCn: "測試項目B", nameEn: null },
  ],
};

const envelope = seal(TEST_SECRET_B64, KID, BODY, REQ_CONTEXT);

const fixture = {
  _meta: {
    spec: "cwi-final S2-9 信封 test vector（wa-inbox ⇄ workforce 共用 — 兩 repo 同一份檔）",
    secret_b64: TEST_SECRET_B64,
    secret_note: "固定測試 key（只係 test vector，唔係生產密鑰；生產 = openssl rand -base64 48）",
    kid: KID,
    context: REQ_CONTEXT,
    body: BODY,
    generated_at: new Date().toISOString(),
    generated_by: "scripts/gen-llm-envelope-fixture.ts（wa-clinic-inbox）",
    usage: "open(secret_b64, envelope, context) 必須還原 body；context 改任何一字 → open throw",
  },
  envelope,
};

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "llm-envelope.v1.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.log(`OK: wrote ${path.relative(process.cwd(), out)}`);
console.log(`  ts=${envelope.ts} nonce=${envelope.nonce}`);
