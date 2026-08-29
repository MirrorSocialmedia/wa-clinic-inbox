/**
 * mock-flow-client — 模擬病人端行 WhatsApp Flow（MD §8.2 加密 round-trip 測試）
 *
 * 真 WhatsApp Flow 由 WhatsApp 平台 call data_exchange endpoint + 攞 encryption key；
 * 沙箱冇真 WA — 呢個 script 扮演病人手機：
 *   1. 用 server 嘅 RSA 公鑰（.dev/flow-keys/）wrap 一把新 AES-128 key（同 WhatsApp 做法一致）
 *   2. AES-128-GCM 加密 request body（同 WhatsApp 格式）
 *   3. POST /api/flows/endpoint → 解密 response（驗證「IV bitwise-NOT 取反」行為）
 *   4. `complete`：產出 nfm_reply webhook payload（加密 response_json）POST /api/wa/webhook
 *
 * 用法（repo root）：
 *   pnpm flow-client step --clinic TKW --conv <convId> --token <jwt> \
 *     [--action SCREEN_PROVIDER|SCREEN_DATE|SCREEN_TIME] [--provider <id>] [--date <YYYY-MM-DD>]
 *   pnpm flow-client step ... --bad-token        # T27：壞 token → 401
 *   pnpm flow-client complete --clinic TKW --conv <convId> --token <jwt> \
 *     --provider <id> --providerName <name> --date <YYYY-MM-DD> --time <HH:mm> \
 *     --wa-id <W> [--wamid <unique>] [--name <姓名>] [--notes <備註>]
 *   pnpm flow-client stepx --clinic TKW --token <jwt> --action INIT|data_exchange|BACK \
 *     [--screen SCR_DATE|SCR_SLOT|SCR_CONFIRM] [--data '<json>'] [--bad-token]
 *     [--no-token]（ping / error_notification：平台層 action，payload 唔帶 flow_token — cwi-flowping-20260828）
 *     # cwi-r2：生產真 spec 信封（{encrypted_flow_data, encrypted_aes_key, initial_vector}）round-trip；
 *     # response = text/plain base64，解密後 = {version:"3.0", screen, data}
 *
 * 輸出（俾 bash assert）：
 *   step:     HTTP=<code> DATA=<json>   /   HTTP=<code> ERROR=<code>
 *   complete: OK wamid=<wamid>
 *
 * ★ PII：script 唔 log payload 內容（同 mock-inbound 鐵律）。
 */
import { createHmac, randomBytes } from "node:crypto";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { PrismaClient } from "@prisma/client";
import {
  ensureKeypair,
  wrapAesKey,
  encryptGcm,
  decryptGcm,
  reversedIv,
} from "../src/lib/flows/crypto";

const prisma = new PrismaClient();

const PORT = process.env.PORT ?? "3100";
const ENDPOINT_URL = `http://127.0.0.1:${PORT}/api/flows/endpoint`;
const WEBHOOK_URL = `http://127.0.0.1:${PORT}/api/wa/webhook`;
const SECRET = process.env.WA_APP_SECRET ?? "";

// ── CLI parse ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const opts: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[arg.slice(2)] = next;
        i++;
      } else {
        // ★ boolean flag（例如 --bad-token）— 無 value → "1"（truthy）
        opts[arg.slice(2)] = "1";
      }
    }
  }
}

function requireOpt(name: string): string {
  const v = opts[name];
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

async function loadClinic(code: string) {
  const clinic = await prisma.clinic.findUnique({ where: { code } });
  if (!clinic) {
    console.error(`clinic ${code} not found`);
    process.exit(2);
  }
  return clinic;
}

async function loadConvWaId(clinicId: string, convId: string): Promise<string> {
  const conv = await prisma.conversation.findUnique({ where: { id: convId } });
  if (!conv) {
    console.error(`conversation ${convId} not found`);
    process.exit(2);
  }
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  return contact?.waId ?? "";
}

// ── step（data_exchange round-trip） ────────────────────────────────────

async function step(): Promise<void> {
  const clinic = await loadClinic(requireOpt("clinic"));
  const convId = requireOpt("conv");
  let token = requireOpt("token");
  if (opts["bad-token"]) token = `${token.slice(0, Math.max(1, token.length - 4))}xxxx`;
  const action = opts.action ?? "SCREEN_PROVIDER";
  const waId = opts["wa-id"] || (await loadConvWaId(clinic.id, convId));

  const kp = ensureKeypair();
  const aesKey = randomBytes(16);
  const iv = randomBytes(12);
  const plain: Record<string, unknown> = { action, flow_token: token };
  if (opts.provider) plain.providerId = opts.provider;
  if (opts.date) plain.date = opts.date;

  const body = {
    phone_number_id: clinic.waPhoneNumberId,
    wa_id: waId,
    data_exchange: {
      encrypted: {
        payload: encryptGcm(aesKey, iv, plain).payload,
        iv: iv.toString("base64"),
        key_id: kp.kid,
        wrapped_key: wrapAesKey(kp.publicPem, aesKey),
      },
    },
  };
  const raw = JSON.stringify(body);
  const res = await fetch(ENDPOINT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.status >= 200 && res.status < 300) {
    // 解密 response（★★ 驗證 IV bitwise-NOT 取反）
    const rj = data.response_json as { payload: string; iv: string; key_id?: string };
    const respIvBuf = reversedIv(iv.toString("base64"));
    if (Buffer.from(rj.iv, "base64").toString("hex") !== respIvBuf.toString("hex")) {
      console.error("REVERSED_IV_MISMATCH: response iv 唔係 request iv 嘅 bitwise-NOT 取反（~byte & 0xFF）");
      process.exit(1);
    }
    const respPlain = JSON.parse(decryptGcm(aesKey, rj.iv, rj.payload)) as {
      action: string;
      data: unknown;
      data_count: number;
    };
    console.log(`HTTP=${res.status} DATA=${JSON.stringify(respPlain)}`);
    return;
  }
  console.log(`HTTP=${res.status} ERROR=${String(data.error ?? "unknown")}`);
  process.exit(1);
}

// ── complete（nfm_reply webhook） ───────────────────────────────────────

async function complete(): Promise<void> {
  const clinic = await loadClinic(requireOpt("clinic"));
  const convId = requireOpt("conv");
  const token = requireOpt("token");
  const providerId = requireOpt("provider");
  const providerName = requireOpt("providerName");
  const date = requireOpt("date");
  // time（正常變體 HH:mm）或 timeOfDay（純收需求變體 MORNING/AFTERNOON/EVENING — 資料源離線 Flow）
  const time = opts.time ?? "";
  const timeOfDay = opts["timeOfDay"] ?? "";
  if (!time && !timeOfDay) {
    console.error("missing --time (or --timeOfDay for requirement variant)");
    process.exit(2);
  }
  const waId = opts["wa-id"] || (await loadConvWaId(clinic.id, convId));
  if (!waId) {
    console.error("cannot resolve wa_id for conversation");
    process.exit(2);
  }
  const wamid = opts.wamid ?? `wamid.FLOW_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

  const kp = ensureKeypair();
  const aesKey = randomBytes(16);
  const iv = randomBytes(12);
  const replyPayload: Record<string, unknown> = {
    flow_token: token,
    providerId,
    providerName,
    date,
  };
  if (time) replyPayload.time = time;
  if (timeOfDay) replyPayload.timeOfDay = timeOfDay; // self-describing：endpoint 由 shape 分變體
  // §D/cwi-r2：真 Flow 確認屏嘅新 params（姓名/備註）— flow-reply 會容納（extra 欄忽略，唔碎寫入路徑）
  if (opts.name) replyPayload.name = opts.name;
  if (opts.notes) replyPayload.notes = opts.notes;
  const { payload, iv: payloadIv } = encryptGcm(aesKey, iv, replyPayload);

  const bizNumber = (clinic.waDisplayNumber ?? "").replace(/\D/g, "");
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: clinic.waPhoneNumberId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: bizNumber, phone_number_id: clinic.waPhoneNumberId },
              contacts: [{ profile: { name: `E2E Patient ${waId.slice(-4)}` }, wa_id: waId }],
              messages: [
                {
                  from: waId,
                  id: wamid,
                  timestamp: ts,
                  type: "interactive",
                  interactive: {
                    type: "nfm_reply",
                    // ★ 真實 WhatsApp 格式：response_json 嵌喺 nfm_reply 入面（同 worker parser 對齊）
                    nfm_reply: {
                      response_json: {
                        payload,
                        iv: payloadIv,
                        key_id: kp.kid,
                        wrapped_key: wrapAesKey(kp.publicPem, aesKey),
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const raw = JSON.stringify(body);
  if (!SECRET) {
    console.error("WA_APP_SECRET missing（.env 要有）");
    process.exit(2);
  }
  const signature = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
  if (res.status === 200) {
    console.log(`OK wamid=${wamid}`);
  } else {
    console.error(`webhook FAILED: HTTP ${res.status} — ${await res.text().catch(() => "")}`);
    process.exitCode = 1;
  }
}

// ── stepx（生產真 spec 信封 round-trip — cwi-r2） ──────────────────

async function stepx(): Promise<void> {
  await loadClinic(requireOpt("clinic"));
  // --no-token：ping / error_notification 平台層 action（cwi-flowping-20260828）— payload 唔帶 flow_token
  const noToken = !!opts["no-token"];
  let token = noToken ? "" : requireOpt("token");
  if (opts["bad-token"]) token = `${token.slice(0, Math.max(1, token.length - 4))}xxxx`;
  const action = requireOpt("action");
  const screen = opts.screen ?? "";
  const data = opts.data ? (JSON.parse(opts.data) as Record<string, unknown>) : {};

  const kp = ensureKeypair();
  const aesKey = randomBytes(16);
  const iv = randomBytes(16); // ★ Meta 真 spec IV = 16 bytes（生產 ping 500 根因對齊 — cwi-ivlen-20260829）
  const plain: Record<string, unknown> = { version: "3.0", action, screen, data };
  if (token) plain.flow_token = token;

  // 生產真 spec 信封（無 key_id / 無 wa_id / 無 phone_number_id）
  const body = {
    encrypted_flow_data: encryptGcm(aesKey, iv, plain).payload,
    encrypted_aes_key: wrapAesKey(kp.publicPem, aesKey),
    initial_vector: iv.toString("base64"),
  };
  const raw = JSON.stringify(body);
  const res = await fetch(ENDPOINT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
  const text = await res.text();

  if (res.status >= 200 && res.status < 300 && (res.headers.get("content-type") ?? "").includes("text/plain")) {
    // 解密 response（★ IV bitwise-NOT 取反 — 同 server 端 reversedIv 一致）— 明文 = {version, screen, data}
    const respIvB64 = Buffer.from(iv.map((b) => ~b & 0xff)).toString("base64");
    const respPlain = JSON.parse(decryptGcm(aesKey, respIvB64, text)) as Record<string, unknown>;
    console.log(`HTTP=${res.status} DATA=${JSON.stringify(respPlain)}`);
    return;
  }
  // 4xx/5xx plaintext JSON（認證/結構錯誤）
  let code = "unknown";
  try {
    code = String((JSON.parse(text) as { error?: string }).error ?? "unknown");
  } catch {
    /* keep unknown */
  }
  console.log(`HTTP=${res.status} ERROR=${code}`);
  process.exit(1);
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (cmd === "step") await step();
  else if (cmd === "stepx") await stepx();
  else if (cmd === "complete") await complete();
  else {
    console.error("usage: flow-client <step|stepx|complete> [options]");
    process.exit(2);
  }
}

main()
  .catch((err) => {
    console.error("[flow-client] error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
