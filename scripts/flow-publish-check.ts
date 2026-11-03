/**
 * Flow 發佈診斷（Flow Builder「發佈這個流程的事前準備」清單空白時用）
 *
 * 喺 production server（有 .env + FLOW_KEYS_DIR 嗰部機）行：
 *   pnpm -s flow-publish-check                      # 唯讀診斷（唔改任何嘢）
 *   pnpm -s flow-publish-check --flow <FLOW_ID>     # 指定 Flow（預設 env FLOW_ID）
 *   pnpm -s flow-publish-check --upload-key         # 將本機公鑰上載 + 簽到 WA_PHONE_NUMBER_ID
 *   pnpm -s flow-publish-check --publish            # 經 API 發佈 — Meta 會回明確錯誤訊息
 *   pnpm -s flow-publish-check --list               # 列出 token 可達嘅所有 WABA + 號碼 + 公鑰 + Flows
 *   （--waba <id> / --phone <id> / --flow <id> 可指定其他 WABA，例如診所正式 WABA）
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
let isTestWaba = false; // Meta 開 app 時自動建嘅沙盒 WABA（Test WhatsApp Business Account / Test Number）
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

  // ── 0. Access token 權限 ──
  // 讀到 Flow 但 POST publish 回 code=100「does not exist / missing permissions」= token 讀得唔管得：
  // 要 whatsapp_business_management scope，而且 granular target 要包含呢個 WABA
  console.log("\n[0] Access token 權限");
  const dbg = await graph(`debug_token?input_token=${encodeURIComponent(token)}`);
  const td = (dbg.body.data ?? {}) as J;
  const tokenTargets = new Map<string, string[] | null>(); // scope → target ids（null = 全部）
  if (!dbg.ok || !td.scopes) {
    info(`讀唔到 token 資料（唔影響其他檢查）：${dbg.ok ? JSON.stringify(dbg.body).slice(0, 200) : graphErr(dbg)}`);
  } else {
    const exp = Number(td.expires_at ?? 0);
    info(`type=${td.type} app=${td.application ?? ""} (${td.app_id}) user_id=${td.user_id ?? "?"} 到期=${exp ? new Date(exp * 1000).toISOString() : "永不"}`);
    check(td.is_valid === true, "token 有效", `token 無效：${JSON.stringify(td.error ?? {})}`);
    for (const g of (td.granular_scopes ?? []) as Array<J>) tokenTargets.set(g.scope, (g.target_ids as string[] | undefined) ?? null);
    for (const sc of ["whatsapp_business_management", "whatsapp_business_messaging"]) {
      check((td.scopes as string[]).includes(sc), `scope ${sc}`, `token 冇 ${sc} scope → 重新產生 system user token 時剔埋`);
    }
    if (exp && exp * 1000 - Date.now() < 7 * 86400_000) bad("token 7 日內到期（臨時 token？production 要用 system user 永久 token）");
  }

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
  if (wabaId && tokenTargets.has("whatsapp_business_management")) {
    const t = tokenTargets.get("whatsapp_business_management");
    check(
      t === null || (t ?? []).includes(wabaId),
      `token 嘅 whatsapp_business_management 涵蓋 WABA ${wabaId}`,
      `token 嘅 whatsapp_business_management 只涵蓋 [${(t ?? []).join(", ")}]，唔包 WABA ${wabaId} → 商業設定 → 系統用戶 → 指派資產：WhatsApp 帳戶揀呢個 WABA（完全控制）再重新產生 token`,
    );
  }
  const phones: Array<J> = [];
  if (!wabaId) {
    bad("冇 WABA id（WA_WABA_ID / --waba）— 只檢查 WA_PHONE_NUMBER_ID");
    if (phoneId) phones.push({ id: phoneId });
  } else {
    const w = await graph(`${wabaId}?fields=id,name,account_review_status,business_verification_status`);
    if (w.ok) {
      const b = w.body as J;
      if (/^Test WhatsApp Business Account/i.test(String(b.name ?? ""))) isTestWaba = true;
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
    if (ph.verified_name === "Test Number") isTestWaba = true;
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
    // 連續 ping 3 次：第 1 次包 DNS + TLS 握手；之後 keep-alive 重用連線 ≈ server 處理時間
    const times: number[] = [];
    let shapeOk = true;
    for (let i = 0; i < 3; i++) {
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
        const text = await res.text();
        times.push(Date.now() - t0);
        if (res.status !== 200) {
          bad(`HTTP ${res.status} ${text.slice(0, 200)}`);
          shapeOk = false;
          break;
        }
        let plain = "";
        try {
          plain = decryptGcm(key16, reversedIv(iv.toString("base64")).toString("base64"), text);
        } catch {
          bad("回應解密失敗（IV 取反 / AES-GCM 唔啱）");
          shapeOk = false;
          break;
        }
        if (plain !== '{"data":{"status":"active"}}') {
          bad(`回應形狀唔啱 Meta spec：${plain}`);
          shapeOk = false;
          break;
        }
      } catch (e) {
        bad(`連唔到 endpoint：${(e as Error).message}`);
        shapeOk = false;
        break;
      }
    }
    if (shapeOk) ok('回應 = {"data":{"status":"active"}}（3/3）');
    if (times.length > 0) {
      const best = Math.min(...times);
      info(`延遲：${times.map((t) => `${t}ms`).join(" / ")}（第 1 次含 DNS + TLS 握手）`);
      check(best < 1000, `最快 ${best}ms（連線重用後）`, `連線重用後仍要 ${best}ms — server 處理慢（Meta 要求快速回應）`);
    }
  }

  // ── 4. 經 API 發佈（可選）──
  if (flag("--publish")) {
    console.log("\n[4] 經 API 發佈");
    if (!flowId) bad("冇 FLOW_ID");
    else {
      const r = await graph(`${flowId}/publish`, { method: "POST" });
      check(r.ok, `已發佈：${JSON.stringify(r.body)}`, `發佈失敗（呢句就係真正原因）：${graphErr(r)}`);
      const code = ((r.body.error ?? {}) as J).code;
      if (!r.ok && code === 100 && isTestWaba) {
        console.log("       → 呢個係 Meta 自動建嘅測試 WABA（Test WhatsApp Business Account / Test Number）。");
        console.log("         權限、公鑰、endpoint 全部通過但 publish 仍回 code=100 = 測試 WABA 唔支援發佈 Flow。");
        console.log("         • 測試：唔使發佈 — .env 設 FLOW_ID=<呢個草稿 Flow ID> + WA_FLOW_DRAFT=1，真機照開到（draft mode）");
        console.log("         • 正式：喺有真號碼嘅 WABA 建 Flow（貼 docs/flow-booking-v73.json）→ 連 app + endpoint →");
        console.log("           pnpm -s flow-publish-check --phone <真號碼 id> --upload-key → 再 --flow <新 id> --publish");
      } else if (!r.ok && code === 100) {
        console.log("       → code=100 但上面讀 Flow 成功 = token 讀得唔管得（權限問題，唔係 Flow 內容問題）：");
        console.log("         1) business.facebook.com/settings → 用戶 → 系統用戶 → 揀 token 嗰個系統用戶 → 指派資產");
        console.log("            → WhatsApp 帳戶 → 呢個 WABA → 開「完全控制」（唔係只係部分權限）");
        console.log("         2) 同一頁「應用程式」→ 確保 CLINIC_INBOX app 已指派俾佢");
        console.log("         3) 重新產生 token，剔 whatsapp_business_management + whatsapp_business_messaging → 更新 .env WA_ACCESS_TOKEN");
        console.log("         ＊ Flow Builder 個「發佈」同樣要你個人 Facebook 帳戶對呢個 WABA 有「完全控制」— 一併喺「WhatsApp 帳戶 → 人員」檢查");
      }
    }
  }

  // ── 5. 列出 token 可達嘅 WABA + 每個 WABA 嘅號碼 / Flows（--list）──
  // 用途：搵 Flow ID 屬邊個 WABA；確認 token / 系統用戶有冇被指派到診所 WABA
  if (flag("--list")) {
    console.log("\n[5] token 可達嘅 WABA");
    const ids = new Set<string>();
    for (const sc of ["whatsapp_business_management", "whatsapp_business_messaging"]) {
      for (const id of tokenTargets.get(sc) ?? []) ids.add(id);
    }
    if (wabaId) ids.add(wabaId);
    if (ids.size === 0) bad("token 冇任何 WABA target（debug_token 讀唔到 / 系統用戶未指派 WhatsApp 帳戶）");
    for (const id of ids) {
      const w = await graph(`${id}?fields=id,name,account_review_status,business_verification_status`);
      if (!w.ok) {
        info(`${id}：唔係 WABA 或讀唔到（${graphErr(w)}）`);
        continue;
      }
      const b = w.body as J;
      console.log(`  ■ WABA ${b.name} (${b.id}) review=${b.account_review_status ?? "?"} verification=${b.business_verification_status ?? "?"}`);
      const p = await graph(`${id}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type,name_status`);
      if (!p.ok) bad(`  讀號碼失敗：${graphErr(p)}`);
      const nums = ((p.body.data ?? []) as Array<J>);
      if (p.ok && nums.length === 0) info("    （冇號碼）");
      for (const n of nums) {
        const e = await graph(`${n.id}/whatsapp_business_encryption`);
        const d = ((e.body.data ?? []) as Array<J>)[0];
        const key = !e.ok ? "公鑰讀唔到" : !d?.business_public_key ? "未上載公鑰" : `公鑰 ${d.business_public_key_signature_status}${sameKey(d.business_public_key, kp.publicPem) ? "（= 本機）" : "（≠ 本機）"}`;
        info(`  號碼 ${n.display_phone_number} (${n.id}) ${n.verified_name} status=${n.status} platform=${n.platform_type} name=${n.name_status} ${key}`);
      }
      const f = await graph(`${id}/flows?fields=id,name,status,categories`);
      if (!f.ok) bad(`  讀 Flows 失敗：${graphErr(f)}`);
      for (const fl of ((f.body.data ?? []) as Array<J>)) info(`  Flow ${fl.name} (${fl.id}) ${fl.status}`);
    }
  }

  console.log(problems === 0 ? "\n結果：全部通過" : `\n結果：${problems} 項有問題（見 ❌）`);
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("診斷中斷：", (e as Error).message);
  process.exit(2);
});
