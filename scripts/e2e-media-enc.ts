/**
 * e2e-media-enc — 媒體 per-file AES-256-GCM 單元/E2E（安全審計 C-1b，跑喺獨立 process）
 *
 * 點解獨立 process：要喺同一 session 內改 MEDIA_ENC_KEY / NODE_ENV / WA_MEDIA_DIR —
 * 唔想污染主 e2e server/worker 嘅 env。
 *
 * 斷言（全部通過先出 MEDIA-ENC OK）：
 *  A. dev + key：save → 碟上密文（WA1| magic、明文 0 hit）+ read 回原文 roundtrip
 *  B. dev 無 key：明文落碟 + read 照行（e2e sandbox 軌）
 *  C. key 環境讀 legacy 明文檔（無 magic）→ 照回（上線過渡期）
 *  D. production + 不可寫目錄 → MediaDirError（fail-fast，禁 /tmp fallback）
 *  E. production + 無 key → MediaKeyError（寧 skip 唔得明文）
 *  F. 目錄 0700 / 檔案 0600
 *  G. 密文被竄改 → GCM auth 失敗 throw（tamper 偵測）
 *
 * 用法：pnpm e2e:media-enc
 */
import { stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

// ★ 故意唔 loadEnvFile — 呢個 process 自己控制 env
const TEST_DIR = path.join(os.tmpdir(), `wa-media-enc-e2e-${process.pid}`);

let failures = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${extra}`);
    failures += 1;
  }
}

// process.env 動態改（TS typing 將 NODE_ENV 當 read-only — 用 string index 繞過）
function setEnv(k: string, v: string): void {
  (process.env as Record<string, string>)[k] = v;
}

async function main(): Promise<void> {
  // 唔想 .env 嘅 WA_MEDIA_DIR 干擾 — 每個 test 自己設
  delete process.env.DISK_ENCRYPTED;
  const KEY = randomBytes(32).toString("hex"); // 64 hex chars

  // ── A. dev + key：密文落碟 + roundtrip ─────────────────────────────────
  setEnv("NODE_ENV", "development");
  setEnv("MEDIA_ENC_KEY", KEY);
  setEnv("WA_MEDIA_DIR", TEST_DIR);
  const media = await import("../src/lib/wa/media");

  const plain = Buffer.from(`MEDIA-PLAIN-SECRET-${randomBytes(8).toString("hex")}`, "utf8");
  const fpA = await media.saveMediaFile("wamid.A.jpg", plain);
  const diskA = await (await import("node:fs/promises")).readFile(fpA);
  check("A1 碟上係密文（WA1| magic）", diskA.subarray(0, 4).toString("utf8") === "WA1|");
  check("A2 碟上明文 0 hit", !diskA.includes(plain));
  const backA = await media.readMediaFile("wamid.A.jpg");
  check("A3 serve 解密 roundtrip 一致", backA.equals(plain));

  // 冪等：重寫唔變（size 相同 → skip）
  const mtime1 = (await stat(fpA)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await media.saveMediaFile("wamid.A.jpg", plain);
  const mtime2 = (await stat(fpA)).mtimeMs;
  check("A4 冪等重寫（mtime 唔變）", mtime1 === mtime2);

  // ── B. dev 無 key：明文軌（e2e sandbox） ───────────────────────────────
  delete process.env.MEDIA_ENC_KEY;
  setEnv("WA_MEDIA_DIR", path.join(TEST_DIR, "plain"));
  const plainB = Buffer.from("e2e-media-bytes-plain", "utf8");
  const fpB = await media.saveMediaFile("wamid.B.jpg", plainB);
  const diskB = await (await import("node:fs/promises")).readFile(fpB);
  check("B1 dev 無 key 明文落碟", diskB.equals(plainB));
  const backB = await media.readMediaFile("wamid.B.jpg");
  check("B2 dev 無 key read 照行", backB.equals(plainB));

  // ── C. key 環境讀 legacy 明文檔（無 magic → 過渡期） ────────────────────
  const legacyFp = path.join(TEST_DIR, "plain", "wamid.C.jpg");
  await writeFile(legacyFp, Buffer.from("legacy-plaintext-content", "utf8"));
  setEnv("MEDIA_ENC_KEY", KEY); // 有 key 但檔無 magic
  const backC = await media.readMediaFile("wamid.C.jpg");
  check("C1 legacy 明文檔（有 key 環境）照讀", backC.toString("utf8") === "legacy-plaintext-content");

  // ── D. production + 不可寫目錄 → fail-fast ─────────────────────────────
  const tmpWaMediaPreExisting = await dirExists("/tmp/wa-media");
  // 不可寫 parent = 普通檔（mkdir 喺檔底下 → 即刻 ENOTDIR；
  // 唔用 /proc — 部分 container 對 /proc mkdir 會 hang，嗰個係環境怪象唔係代碼問題）
  const blockFile = path.join(TEST_DIR, "blockfile");
  await writeFile(blockFile, "x");
  setEnv("NODE_ENV", "production");
  setEnv("WA_MEDIA_DIR", `${blockFile}/inner`);
  let threwD = false;
  try {
    await media.ensureMediaDir();
  } catch (err) {
    threwD = err instanceof media.MediaDirError;
  }
  check("D1 production 不可寫目錄 → MediaDirError（fail-fast）", threwD);
  let threwD2 = false;
  try {
    await media.saveMediaFile("wamid.D.jpg", Buffer.from("x"));
  } catch (err) {
    threwD2 = err instanceof media.MediaDirError;
  }
  check("D2 production save fail-fast（唔 fallback /tmp）", threwD2);
  check(
    "D3 /tmp/wa-media 未被 fallback 新建",
    tmpWaMediaPreExisting || !(await dirExists("/tmp/wa-media"))
  );

  // ── E. production + 無 key → MediaKeyError ─────────────────────────────
  delete process.env.MEDIA_ENC_KEY;
  setEnv("WA_MEDIA_DIR", path.join(TEST_DIR, "prod"));
  let threwE = false;
  try {
    await media.saveMediaFile("wamid.E.jpg", Buffer.from("x"));
  } catch (err) {
    threwE = err instanceof media.MediaKeyError && err.message.includes("MEDIA_ENC_KEY");
  }
  check("E1 production 無 key save → MediaKeyError", threwE);

  // production + key → 照行（密文）
  setEnv("MEDIA_ENC_KEY", KEY);
  const fpE = await media.saveMediaFile("wamid.E2.jpg", Buffer.from("prod-enc-x"));
  const diskE = await (await import("node:fs/promises")).readFile(fpE);
  check("E2 production + key 密文落碟", diskE.subarray(0, 4).toString("utf8") === "WA1|");

  // ── F. 權限：目錄 0700 / 檔案 0600 ─────────────────────────────────────
  const dirMode = (await stat(path.join(TEST_DIR, "prod"))).mode & 0o777;
  const fileMode = (await stat(fpE)).mode & 0o777;
  check("F1 目錄 0700", dirMode === 0o700, `(got ${dirMode.toString(8)})`);
  check("F2 檔案 0600", fileMode === 0o600, `(got ${fileMode.toString(8)})`);

  // ── G. tamper 偵測（GCM auth） ─────────────────────────────────────────
  const sA = diskA.toString("utf8");
  const tampered = Buffer.from(sA.slice(0, sA.length - 16) + "0".repeat(16), "utf8");
  let threwG = false;
  try {
    media.decryptMedia(tampered, Buffer.from(KEY, "hex"));
  } catch {
    threwG = true;
  }
  check("G1 密文竄改 → GCM auth 失敗 throw", threwG);

  // cleanup
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => undefined);

  if (failures > 0) {
    console.log(`MEDIA-ENC FAIL: ${failures} 項失敗`);
    process.exit(1);
  }
  console.log("MEDIA-ENC OK");
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.log(`MEDIA-ENC FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
