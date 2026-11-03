/**
 * Flow 發佈診斷（Flow Builder「發佈這個流程的事前準備」清單空白時用）
 *
 * 喺 production server（有 .env + FLOW_KEYS_DIR 嗰部機）行：
 *   pnpm -s flow-publish-check                      # 唯讀診斷（唔改任何嘢）
 *   pnpm -s flow-publish-check --flow <FLOW_ID>     # 指定 Flow（預設 env FLOW_ID）
 *   pnpm -s flow-publish-check --upload-key         # 將本機公鑰上載 + 簽到 WA_PHONE_NUMBER_ID
 *   pnpm -s flow-publish-check --publish            # 經 API 發佈 — Meta 會回明確錯誤訊息
 *
 * 檢查：
 *   1. Flow 本身：status / validation_errors / endpoint_uri / application（Meta app 有冇連）/ health_status
 *      （health_status.entities 逐個列 FLOW / WABA / BUSINESS / APP / PHONE_NUMBER 嘅 BLOCKED 原因）
 *   2. WABA 下每個電話號碼：狀態 + 公鑰有冇上載 + 簽名 VALID/MISMATCH + 同本機公鑰係咪同一把
 *   3. 自己 ping 自己 endpoint（用本機公鑰加密 + WA_APP_SECRET 簽名）→ 回應形狀 + 延遲
 *
 * ★ 唔印 access token / app secret / 私鑰；電話號碼只印商業號碼（非病人 PII）。
 */
import crypto from "node:crypto";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { decryptGcm, encryptGcm, ensureKeypair, reversedIv, wrapAesKey } from "../src/lib/flows/crypto";

const GRAPH = "https://graph.facebook.com/v23.0";
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const token = process.env.WA_ACCESS_TOKEN ?? "";
const flowId = opt("--flow") ?? process.env.FLOW_ID ?? "";
const phoneId = opt("--phone") ?? process.env.WA_PHONE_NUMBER_ID ?? "";
let wabaId = opt("--waba") ?? process.env.WA_WABA_ID ?? "";

let problems = 0;
const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string) => {
  problems++;
  console.log(`  ❌ ${m}`);
};
const info = (m: string) => console.log(`  ·  ${m}`);
const check = (cond: boolean, okMsg: string, badMsg: string) => (cond ? ok(okMsg) : bad(badMsg));

// Graph 回應係動態 JSON — 診斷 script 用寬鬆型別
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
type GraphResult = { ok: boolean; status: number; body: Record<string, unknown> };

async function graph(path: string, init?: RequestInit): Promise<GraphResult> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, status: 0, body: { error: { message: `連唔到 Graph API：${(e as Error).message}` } } };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

function graphErr(r: GraphResult): string {
  const e = (r.body.error ?? {}) as Record<string, unknown>;
  return `HTTP ${r.status} code=${e.code ?? "?"} ${e.error_user_title ?? ""} ${e.error_user_msg ?? e.message ?? JSON.stringify(r.body).slice(0, 300)}`.trim();
}

/** 公鑰比較：統一轉 SPKI DER 再比（PEM 換行 / header 差異唔影響） */
function sameKey(aPem: string, bPem: string): boolean {
  try {
    const a = crypto.createPublicKey(aPem).export({ type: "spki", format: "der" });
    const b = crypto.createPublicKey(bPem).export({ type: "spki", format: "der" });
    return a.equals(b);
  } catch {
    return false;
  }
}

async function main() {
  console.log("== Flow 發佈診斷 ==");
  if (!token) {
    console.log("❌ 未設 WA_ACCESS_TOKEN — 喺 production .env 所在目錄行");
    process.exit(2);
  }
  const kp = ensureKeypair();
  info(`本機公鑰：FLOW_KEYS_DIR=${process.env.FLOW_KEYS_DIR ?? ".dev/flow-keys"} kid=${kp.kid}`);

  // ── 1. Flow ──
  console.log("\n[1] Flow");
  let endpointUri = "";
  if (!flowId) {
    bad("冇 FLOW_ID — 用 --flow <id>（Flow Builder 網址 / WhatsApp Manager 個 Flow 頁有）");
  } else {
    const r = await graph(
      `${flowId}?fields=id,name,status,categories,validation_errors,json_version,data_api_version,endpoint_uri,application,whatsapp_business_account,health_status`,
    );
    if (!r.ok) {
      bad(`讀 Flow 失敗：${graphErr(r)}`);
    } else {
      const f = r.body as J;
      info(`name=${f.name} status=${f.status} json_version=${f.json_version} data_api_version=${f.data_api_version}`);
      endpointUri = f.endpoint_uri ?? "";
      check(!!endpointUri, `endpoint_uri=${endpointUri}`, "Flow 未設 endpoint_uri");
      if (f.application?.id) ok(`已連 Meta app：${f.application.name ?? ""} (${f.application.id})`);
      else bad("Flow 未連 Meta app — Flow Builder →「編輯」→ 端點設定揀返個 app（要同 WA_APP_SECRET 嗰個 app 一致）");
      if (!wabaId && f.whatsapp_business_account?.id) wabaId = f.whatsapp_business_account.id;
      const ve = (f.validation_errors ?? []) as Array<Record<string, unknown>>;
      check(ve.length === 0, "validation_errors：無", `validation_errors：${JSON.stringify(ve)}`);
      const hs = f.health_status as J | undefined;
      if (hs) {
        const overall = hs.can_send_message;
        check(overall === "AVAILABLE", `health_status=${overall}`, `health_status=${overall}`);
        for (const e of (hs.entities ?? []) as Array<J>) {
          const line = `${e.entity_type} ${e.id}: ${e.can_send_message}`;
          if (e.can_send_message === "AVAILABLE") info(line);
          else {
            bad(line);
            for (const x of (e.errors ?? []) as Array<J>) {
              console.log(`       → [${x.error_code}] ${x.error_description}${x.possible_solution ? `｜解決：${x.possible_solution}` : ""}`);
            }
          }
        }
      }
    }
  }

  // ── 2. WABA + 電話號碼 + 公鑰 ──
  console.log("\n[2] WABA / 電話號碼 / 公鑰");
  const phones: Array<J> = [];
  if (!wabaId) {
    bad("冇 WABA id（WA_WABA_ID / --waba）— 只檢查 WA_PHONE_NUMBER_ID");
    if (phoneId) phones.push({ id: phoneId });
  } else {
    const w = await graph(`${wabaId}?fields=id,name,account_review_status,business_verification_status`);
    if (w.ok) {
      const b = w.body as J;
      info(`WABA ${b.name} (${b.id}) account_review_status=${b.account_review_status ?? "?"} business_verification_status=${b.business_verification_status ?? "?"}`);
    } else info(`讀 WABA 欄位失敗（唔影響其他檢查）：${graphErr(w)}`);
    const p = await graph(
      `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,name_status,code_verification_status,quality_rating,status,platform_type`,
    );
    if (!p.ok) bad(`讀電話號碼失敗：${graphErr(p)}`);
    else phones.push(...((p.body.data ?? []) as Array<J>));
    if (p.ok && phones.length === 0) bad("WABA 下冇任何電話號碼 — 發佈有 endpoint 嘅 Flow 至少要一個已註冊（Cloud API）並上載咗公鑰嘅號碼");
  }
  for (const ph of phones) {
    console.log(`  — 號碼 ${ph.display_phone_number ?? ""} (${ph.id})${ph.id === phoneId ? " ← WA_PHONE_NUMBER_ID" : ""}`);
    if (ph.status) info(`status=${ph.status} platform=${ph.platform_type} name_status=${ph.name_status} quality=${ph.quality_rating} verified_name=${ph.verified_name}`);
    if (ph.platform_type && ph.platform_type !== "CLOUD_API") bad(`platform_type=${ph.platform_type}（唔係 CLOUD_API — 未 register 落 Cloud API）`);
    const e = await graph(`${ph.id}/whatsapp_business_encryption`);
    if (!e.ok) {
      bad(`讀公鑰失敗：${graphErr(e)}`);
      continue;
    }
    const d = ((e.body.data ?? []) as Array<J>)[0];
    if (!d?.business_public_key) {
      bad("未上載公鑰 → 用 --upload-key（只會上載去 WA_PHONE_NUMBER_ID / --phone）");
      continue;
    }
    check(
      d.business_public_key_signature_status === "VALID",
      "公鑰簽名 VALID",
      `公鑰簽名 ${d.business_public_key_signature_status} → 重新上載（--upload-key）`,
    );
    check(
      sameKey(d.business_public_key, kp.publicPem),
      "Meta 上嘅公鑰 = 本機 FLOW_KEYS_DIR 公鑰",
      "Meta 上嘅公鑰 ≠ 本機公鑰（server 解唔到呢個號碼嘅請求）→ --upload-key --phone <呢個 id>",
    );
  }

  if (flag("--upload-key")) {
    console.log("\n[2b] 上載公鑰");
    if (!phoneId) bad("冇 WA_PHONE_NUMBER_ID / --phone");
    else {
      const r = await graph(`${phoneId}/whatsapp_business_encryption`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ business_public_key: kp.publicPem }).toString(),
      });
      check(r.ok, `已上載去 ${phoneId}（再行一次本 script 確認 VALID）`, `上載失敗：${graphErr(r)}`);
    }
  }

  // ── 3. 自己 ping 自己 endpoint ──
  console.log("\n[3] Endpoint 健康檢查（模擬 Meta ping）");
  const url = opt("--endpoint") ?? endpointUri;
  const appSecret = process.env.WA_APP_SECRET ?? "";
  if (!url) bad("冇 endpoint URL（--endpoint <url>）");
  else if (!appSecret) bad("冇 WA_APP_SECRET — endpoint 會回 432");
  else {
    const key16 = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const enc = encryptGcm(key16, iv, { version: "3.0", action: "ping" });
    const body = JSON.stringify({
      encrypted_flow_data: enc.payload,
      encrypted_aes_key: wrapAesKey(kp.publicPem, key16),
      initial_vector: iv.toString("base64"),
    });
    const sig = "sha256=" + crypto.createHmac("sha256", appSecret).update(body).digest("hex");
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const ms = Date.now() - t0;
      const text = await res.text();
      if (res.status !== 200) bad(`HTTP ${res.status} ${text.slice(0, 200)}`);
      else {
        let plain = "";
        try {
          plain = decryptGcm(key16, reversedIv(iv.toString("base64")).toString("base64"), text);
        } catch {
          bad("回應解密失敗（IV 取反 / AES-GCM 唔啱）");
        }
        if (plain) {
          check(plain === '{"data":{"status":"active"}}', `回應 = ${plain}`, `回應形狀唔啱 Meta spec：${plain}`);
        }
      }
      check(ms < 1000, `延遲 ${ms}ms`, `延遲 ${ms}ms（Meta 要求快速回應，建議 < 1s）`);
    } catch (e) {
      bad(`連唔到 endpoint：${(e as Error).message}`);
    }
  }

  // ── 4. 經 API 發佈（可選）──
  if (flag("--publish")) {
    console.log("\n[4] 經 API 發佈");
    if (!flowId) bad("冇 FLOW_ID");
    else {
      const r = await graph(`${flowId}/publish`, { method: "POST" });
      check(r.ok, `已發佈：${JSON.stringify(r.body)}`, `發佈失敗（呢句就係真正原因）：${graphErr(r)}`);
    }
  }

  console.log(problems === 0 ? "\n結果：全部通過" : `\n結果：${problems} 項有問題（見 ❌）`);
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("診斷中斷：", (e as Error).message);
  process.exit(2);
});
