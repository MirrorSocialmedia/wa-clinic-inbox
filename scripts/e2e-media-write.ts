/**
 * e2e-media-write — 經 saveMediaFile 寫一個 media 檔（e2e T43b 碟上密文 roundtrip 用）
 *
 * 用法：pnpm e2e:media-write <destPath> <srcPath>
 *
 * key 由本 process env MEDIA_ENC_KEY 提供（mock-e2e.sh 會 export 同一把 key 俾
 * e2e server — 寫入側密文，server serve 時解密）。無 key → 明文（dev 行為）。
 * 獨立 process：唔 load .env（key 必須由 caller 明確提供，模擬生產 env 注入）。
 */
import { readFileSync } from "node:fs";
import { saveMediaFile } from "../src/lib/wa/media";

async function main(): Promise<void> {
  const [dest, src] = process.argv.slice(2);
  if (!dest || !src) {
    console.error("usage: e2e:media-write <dest> <src>");
    process.exit(2);
  }
  const plain = readFileSync(src);
  const path = await saveMediaFile(dest, plain);
  console.log(`MEDIA-WRITE OK ${path}`);
}

main().catch((err) => {
  console.error(`MEDIA-WRITE FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
