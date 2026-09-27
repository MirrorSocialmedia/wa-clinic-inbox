/**
 * migrate-media-encrypt — cwi-final S6-3②：legacy 明文媒體檔一次性加密遷移。
 *
 * 背景：S6-3② 之後 production 拒絕 serve 未加密 legacy 明文檔（openMediaStream fail-fast）—
 *   上 production 前必須跑呢個腳本把舊明文檔加密落碟。
 *
 * 用法：npx tsx scripts/migrate-media-encrypt.ts [--dry-run]
 *   --dry-run = 只報數，唔寫檔
 *
 * 行為：
 * - 掃 WA_MEDIA_DIR（預設 /srv/wa-media；e2e 用 /tmp/wa-media-e2e 等 env 覆蓋）全部普通檔
 * - 已有 WA1| magic → skip（冪等）
 * - 明文 → AES-256-GCM 加密（MEDIA_ENC_KEY）回寫（0600）
 * - 每檔加密後用 decryptMedia 回讀驗證（auth tag 對先收工 — 防遷移中斷留半生不熟檔）
 * - 冪等 + 安全：唔會加密已加密檔（雙重加密 = 永久解唔到）
 *
 * ★ PII 鐵律：log 只帶檔名（wamid）+ 大小 + 結果，唔帶任何內容。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env 冇就靠 process env */
}

import { readdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import path from "node:path";
import { encryptMedia, decryptMedia, getMediaKey, isEncryptedMedia, mediaDirPreferred, MAX_MEDIA_BYTES } from "../src/lib/wa/media";

const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const dir = mediaDirPreferred();
  const key = getMediaKey();
  if (!key) {
    console.error("FATAL: MEDIA_ENC_KEY 未設（migration 需要 key 加密舊檔）");
    process.exitCode = 2;
    return;
  }

  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => !f.startsWith("."));
  } catch {
    console.log(`MIGRATE-MEDIA-ENCRYPT: 目錄 ${dir} 唔存在 — 0 檔（新環境無需遷移）`);
    return;
  }

  let migrated = 0;
  let already = 0;
  let skipped = 0;

  for (const name of entries) {
    const fp = path.join(dir, name);
    let st;
    try {
      st = await stat(fp);
    } catch {
      continue;
    }
    if (!st.isFile()) {
      skipped += 1;
      continue;
    }
    if (st.size > MAX_MEDIA_BYTES) {
      console.log(`SKIP ${name}: ${st.size} bytes > 50MB（唔應該有呢種檔 — 人工核）`);
      skipped += 1;
      continue;
    }
    const buf = await readFile(fp);
    if (isEncryptedMedia(buf)) {
      already += 1;
      continue;
    }
    if (DRY_RUN) {
      console.log(`WOULD-MIGRATE ${name}: ${st.size} bytes`);
      migrated += 1;
      continue;
    }
    const enc = encryptMedia(buf, key);
    // 回讀驗證：加密 → 解密 → 對原文（auth tag + 內容一致先算成功）
    const roundTrip = decryptMedia(enc, key);
    if (!roundTrip.equals(buf)) {
      console.error(`FATAL ${name}: round-trip 驗證失敗（唔會回寫）`);
      process.exitCode = 1;
      return;
    }
    await writeFile(fp, enc);
    await chmod(fp, 0o600).catch(() => undefined);
    migrated += 1;
  }

  console.log(
    `MIGRATE-MEDIA-ENCRYPT ${DRY_RUN ? "(dry-run) " : ""}完成: dir=${dir} migrated=${migrated} alreadyEncrypted=${already} skipped=${skipped}`
  );
}

main().catch((e) => {
  console.error("MIGRATE-MEDIA-ENCRYPT ERROR:", e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
});
