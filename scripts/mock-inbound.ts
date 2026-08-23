/**
 * mock-inbound — 造真係 format 嘅 Meta webhook payload 並 POST 本地 webhook（MD §6.2 測試基建）。
 *
 * 用法（repo root）：
 *   pnpm mock-inbound message  --clinic TKW --from 85260011122 --text "你好" [--wamid ...] [--name "病人A"] [--media image]
 *   pnpm mock-inbound echo     --clinic TKW --to 85260011122 --text "店員手機 App 覆" [--wamid ...]
 *   pnpm mock-inbound status   --wamid <wamid> --status sent|delivered|read|failed
 *   pnpm mock-inbound history  --clinic TKW --from 85260011122 [--count 30] [--name "舊病人"]
 *                              [--from2 85260021122 --name2 "舊病人B"]（multi-patient 批次 — P0-2）
 *   pnpm mock-inbound unknown  --clinic TKW          （未知 field — 測試唔崩）
 *
 * - 簽名：x-hub-signature-256 = sha256=<HMAC-SHA256(raw body, WA_APP_SECRET)>
 * - payload 結構跟 Meta 官方 format（object/entry[].changes[].value）
 * - 所有 wamid 可重複 → 配合冪等測試
 *
 * ★ PII 鐵律：mock 內容都唔入 log（呢個 script 唔 log body）。
 */
import { createHmac } from "node:crypto";

// 載入 .env（tsx 唔會自動載；Node 22 內置 loadEnvFile）
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env 冇就靠 process env */
}

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PORT = process.env.PORT ?? "3100";
const WEBHOOK_URL = `http://127.0.0.1:${PORT}/api/wa/webhook`;
const SECRET = process.env.WA_APP_SECRET ?? "";

// ── CLI parse ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const opts: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    opts[rest[i].slice(2)] = rest[i + 1] ?? "";
    i++;
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

// ── payload builders（Meta 官方 format） ────────────────────────────────

interface WaMsg {
  from?: string;
  to?: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { media_id: string; caption?: string };
}

function entry(change: { field: string; value: unknown; phoneId: string }) {
  return { object: "whatsapp_business_account", entry: [{ id: change.phoneId, changes: [change] }] };
}

function buildMessage(clinicPhoneId: string, bizNumber: string, o: {
  from: string;
  wamid: string;
  text: string;
  name?: string;
  media?: string;
  /** ★ Realtime P0 (R4 e2e)：指定 waTimestamp（unix seconds）— 順序壓測要確定性递增 ts */
  ts?: string;
}): unknown {
  const ts = o.ts && o.ts.length > 0 ? o.ts : Math.floor(Date.now() / 1000).toString();
  const msg: WaMsg = {
    from: o.from,
    id: o.wamid,
    timestamp: ts,
    type: o.media ? "image" : "text",
  };
  if (o.media) msg.image = { media_id: `mockmedia_${o.wamid}`, caption: o.text };
  else msg.text = { body: o.text };
  return entry({
    field: "messages",
    phoneId: clinicPhoneId,
    value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: bizNumber, phone_number_id: clinicPhoneId },
      contacts: o.name ? [{ profile: { name: o.name }, wa_id: o.from }] : [],
      messages: [msg],
    },
  });
}

function buildEcho(clinicPhoneId: string, bizNumber: string, o: { to: string; wamid: string; text: string }): unknown {
  const ts = Math.floor(Date.now() / 1000).toString();
  const msg: WaMsg = {
    from: bizNumber, // 店員手機 App（店嘅號碼）發出
    to: o.to,
    id: o.wamid,
    timestamp: ts,
    type: "text",
    text: { body: o.text },
  };
  return entry({
    field: "messages",
    phoneId: clinicPhoneId,
    value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: bizNumber, phone_number_id: clinicPhoneId },
      smb_message_echoes: [{ conversation: { id: `conv_${o.to}` }, message: msg }],
    },
  });
}

function buildStatus(clinicPhoneId: string, o: { wamid: string; status: string; dest: string }): unknown {
  return entry({
    field: "messages",
    phoneId: clinicPhoneId,
    value: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: clinicPhoneId },
      statuses: [
        {
          id: o.wamid,
          destination_jid: `${o.dest}@s.whatsapp.net`,
          status: o.status,
          timestamp: Math.floor(Date.now() / 1000).toString(),
          ...(o.status === "failed" ? { error_code: 131047, errors: [{ code: 131047, message: "mock failed" }] } : {}),
        },
      ],
    },
  });
}

function buildHistory(clinicPhoneId: string, bizNumber: string, o: {
  from: string;
  from2?: string;
  count: number;
  name?: string;
  name2?: string;
}): unknown {
  const now = Math.floor(Date.now() / 1000);
  let msgs: WaMsg[] = [];
  const contacts: { profile: { name: string }; wa_id: string }[] = [];
  if (o.from2) {
    // ★ Multi-patient 批次（P0-2）：兩個病人 + 店員回覆混喺同一批 —
    //   worker 必須逐條歸戶（IN → m.from；OUT → m.to）。
    //   故意多 1 條連 from/to 都冇 → 真無法歸戶 → worker 應該 skip + Alert(history_skip)。
    const mk = (i: number, from: string | undefined, to: string | undefined, body: string): WaMsg => {
      // ★ id 錨定「非商家號」邊（病人）：OUT 訊息嘅 from=商家號係全 run/全店共用 —
      //   錨商家號會令兩個 e2e run（或兩店）嘅 OUT wamid collision →
      //   createMany skipDuplicates 靜默丟後到嗰條（實測事故：T41 長期 o=0）。
      const owner =
        from && from !== bizNumber ? from : to && to !== bizNumber ? to : undefined;
      return {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        id: owner ? `wamid.HIST2_${owner}_${i}` : `wamid.HIST2_UNATTR_${i}_${now}`,
        timestamp: (now - (12 - i) * 3600 * 4).toString(),
        type: "text",
        text: { body },
      };
    };
    msgs = [
      mk(0, o.from, bizNumber, "[歷史M] 病人A 訊息 1"),
      mk(1, o.from2, bizNumber, "[歷史M] 病人B 訊息 1"),
      mk(2, bizNumber, o.from, "[歷史M] 店員覆 A"),
      mk(3, o.from2, bizNumber, "[歷史M] 病人B 訊息 2"),
      mk(4, bizNumber, o.from2, "[歷史M] 店員覆 B"),
      mk(5, o.from, bizNumber, "[歷史M] 病人A 訊息 2"),
      mk(6, undefined, undefined, "[歷史M] 無法歸戶"),
    ];
    if (o.name) contacts.push({ profile: { name: o.name }, wa_id: o.from });
    if (o.name2) contacts.push({ profile: { name: o.name2 }, wa_id: o.from2 });
  } else {
    // 單病人（舊行為 — T6）：30 日內嘅舊 chat：病人/店員各半，亂序（測試容忍亂序）
    for (let i = 0; i < o.count; i++) {
      const isOut = i % 3 === 2; // 每 3 則有 1 則係店發
      const ts = now - (o.count - i) * 3600 * 4 + (i % 7) * 60; // 故意唔完全遞增
      msgs.push({
        from: isOut ? bizNumber : o.from,
        id: `wamid.HIST_${o.from}_${i}`,
        timestamp: ts.toString(),
        type: "text",
        text: { body: isOut ? `[歷史] 店員回覆 ${i}` : `[歷史] 病人訊息 ${i}` },
      });
    }
    if (o.name) contacts.push({ profile: { name: o.name }, wa_id: o.from });
  }
  // 打亂順序（容忍亂序測試）
  const shuffled = [...msgs].sort(() => Math.random() - 0.5);
  return entry({
    field: "messages",
    phoneId: clinicPhoneId,
    value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: bizNumber, phone_number_id: clinicPhoneId },
      contacts,
      history: {
        spans: [{ span: "first_50", is_end_of_history: true, messages: shuffled }],
        is_end_of_history: true,
      },
    },
  });
}

function buildUnknown(clinicPhoneId: string): unknown {
  return entry({
    field: "smb_app_state_sync",
    phoneId: clinicPhoneId,
    value: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: clinicPhoneId },
      sync: { version: 1 },
    },
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!cmd || !["message", "echo", "status", "history", "unknown"].includes(cmd)) {
    console.error("usage: mock-inbound <message|echo|status|history|unknown> [options]");
    console.error("  message: --clinic <code> --from <waId> --text <t> [--wamid] [--name] [--media image]");
    console.error("  echo:    --clinic <code> --to <waId> --text <t> [--wamid]");
    console.error("  status:  --wamid <id> --status <sent|delivered|read|failed> [--clinic <code>]");
    console.error("  history: --clinic <code> --from <waId> [--count N] [--name] [--from2 <waId2>] [--name2]");
    console.error("  unknown: --clinic <code>");
    process.exit(2);
  }

  if (!SECRET) {
    console.error("WA_APP_SECRET missing（.env 要有）");
    process.exit(2);
  }

  // clinic 解決：--clinic <code>（預設 status 用 --clinic 或第一個 clinic）
  let clinic = null;
  const clinicCode = opts.clinic ?? (cmd === "status" ? "" : "");
  if (clinicCode) {
    clinic = await prisma.clinic.findUnique({ where: { code: clinicCode } });
    if (!clinic) {
      console.error(`clinic ${clinicCode} not found`);
      process.exit(2);
    }
  } else if (cmd === "status") {
    clinic = await prisma.clinic.findFirst();
    if (!clinic) {
      console.error("no clinic in DB — seed first");
      process.exit(2);
    }
  } else {
    console.error("--clinic required");
    process.exit(2);
  }

  const bizNumber = (clinic!.waDisplayNumber ?? "").replace(/\D/g, "");
  const wamid =
    opts.wamid ?? `wamid.MOCK${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

  let payload: unknown;
  switch (cmd) {
    case "message":
      payload = buildMessage(clinic!.waPhoneNumberId, bizNumber, {
        from: requireOpt("from"),
        wamid,
        text: opts.text ?? "（mock 訊息）",
        name: opts.name,
        media: opts.media,
        ts: opts.ts,
      });
      break;
    case "echo":
      payload = buildEcho(clinic!.waPhoneNumberId, bizNumber, {
        to: requireOpt("to"),
        wamid,
        text: opts.text ?? "（mock echo）",
      });
      break;
    case "status": {
      const status = requireOpt("status");
      if (!["sent", "delivered", "read", "failed"].includes(status)) {
        console.error("status must be sent|delivered|read|failed");
        process.exit(2);
      }
      // destination_jid：由 DB 搵 wamid 所属嘅 contact（搵唔到就用 fake）
      const existing = await prisma.message.findUnique({ where: { waMessageId: wamid } });
      const contact = existing
        ? await prisma.contact.findUnique({ where: { id: (await prisma.conversation.findUnique({ where: { id: existing.conversationId } }))!.contactId } })
        : null;
      payload = buildStatus(clinic!.waPhoneNumberId, {
        wamid,
        status,
        dest: contact?.waId ?? "85200000000",
      });
      break;
    }
    case "history":
      payload = buildHistory(clinic!.waPhoneNumberId, bizNumber, {
        from: requireOpt("from"),
        from2: opts.from2,
        count: Number(opts.count ?? 30),
        name: opts.name,
        name2: opts.name2,
      });
      break;
    case "unknown":
      payload = buildUnknown(clinic!.waPhoneNumberId);
      break;
  }

  const raw = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });

  if (res.status === 200) {
    console.log(`[mock-inbound] OK (${cmd}, wamid=${wamid})`);
  } else {
    console.error(`[mock-inbound] FAILED: HTTP ${res.status} — ${await res.text().catch(() => "")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[mock-inbound] error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
