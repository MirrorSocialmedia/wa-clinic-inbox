import path from "node:path";
import log from "./log";

/**
 * M-6：production 金鑰路徑 boot check（醒目 WARN，唔 fail — 上真機 checklist 會控）。
 *
 * 私鑰資產（WhatsApp Flow RSA keypair、age backup key）唔應該放 repo working dir 內：
 * repo 目錄受版本控制 / backup / 部署工具觸及 — 金鑰喺 working dir 會跟 repo snapshot
 * 一齊走 / 被誤 commit / 被拷去錯機。上真機慣例：/etc/wa-inbox/（見 .env.example）。
 *
 * 檢查：
 * - FLOW_KEYS_DIR（預設 .dev/flow-keys）
 * - AGE_KEY_FILE（預設 .dev/age.key — 檢查佢嘅父目錄）
 * resolve 做絕對路徑後，喺 repo working dir（= 起 server 嘅 cwd）內 → 醒目 WARN。
 *
 * 點解只 WARN 唔 fail：上真機嘅部署邊 checklist（CEO 持有）係硬性控點；
 * 呢度係第二道防線 — 醒目到 log 一定睇到，但唔會令 server 起唔到。
 */
export function bootKeyPathCheck(): void {
  if (process.env.NODE_ENV !== "production") return; // dev 用 .dev/ 係正常

  const repoDir = path.resolve(process.cwd());
  const entries: Array<{ label: string; dir: string }> = [];

  const flowKeys = (process.env.FLOW_KEYS_DIR ?? "").trim();
  if (flowKeys) {
    entries.push({ label: "FLOW_KEYS_DIR（WhatsApp Flow RSA keypair）", dir: flowKeys });
  }

  const ageKey = (process.env.AGE_KEY_FILE ?? "").trim();
  if (ageKey) {
    entries.push({ label: "AGE_KEY_FILE（age backup key）", dir: path.dirname(ageKey) });
  }

  for (const { label, dir } of entries) {
    const abs = path.resolve(repoDir, dir);
    const inside = abs === repoDir || abs.startsWith(repoDir + path.sep);
    if (inside) {
      log.warn(
        { label, path: abs, repoDir },
        "boot: ⚠️⚠️ 金鑰路徑喺 repo working dir 內 — 應該放 /etc/wa-inbox/ 之外（見 .env.example M-6 註記）。" +
          "唔 fail 係故意（上真機 checklist 硬控）；production 見到呢行 = 金鑰位置錯，上線前必須遷走。"
      );
    }
  }
}
