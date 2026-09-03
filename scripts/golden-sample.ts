/**
 * ★ Part F（cwi-raggolden-20260904，F.7）：golden:sample — 歷史病人句採樣 + Qwen 預標。
 *
 * 用法：pnpm golden:sample --clinic TKW --from 2026-07-01T00:00:00+08:00 --limit 200 [--dry-run]
 *
 * 流程（MD F.7）：
 *   1. 抽 Message(channel=HISTORY, direction=IN, type=text) 病人句（--from 起）
 *   2. 每 conversation ≤2 句（最早兩句 — 病人首句情境）
 *   3. deid（contact profileName）— 零 PII 鐵律
 *   4. Qwen 預標 intent + expectRedFlag（真 LLM — 只係預標，staff 審核先 enabled）
 *   5. 入庫 GoldenCase(source=HISTORY_SAMPLE, enabled=false) — **未審核唔入 eval**
 * 冪等：同 (clinicId, source, utterance) 已存在 → skip。
 */
import { PrismaClient } from "@prisma/client";
import { getAiConfig, chatWithFallback } from "../src/lib/ai/vllm";
import { deid } from "../src/lib/golden/deid";
import log from "../src/lib/log";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch { /* ok */ }

// eval 預標必須用真 LLM（MD F.6 精神：預標只係輔助，但要用真模型先有參考價值）
delete process.env.AI_MOCK;

const args = process.argv.slice(2);
function argVal(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const clinicArg = argVal("--clinic");
const fromArg = argVal("--from");
const limitArg = Number(argVal("--limit") ?? "200");
const dryRun = args.includes("--dry-run");
if (!clinicArg || !fromArg) {
  console.error("用法：pnpm golden:sample --clinic TKW --from <ISO8601> --limit 200 [--dry-run]");
  process.exit(1);
}
const from = new Date(fromArg);
if (Number.isNaN(from.getTime())) {
  console.error("--from 唔係合法日期");
  process.exit(1);
}

const INTENTS = ["BOOKING_REQUEST", "QUESTION", "URGENT_PAIN", "PAIN", "COMPLAINT", "OUT_OF_SCOPE", "OTHER"];

const prisma = new PrismaClient();

async function preLabel(utterance: string, contextBefore: string[]): Promise<{ intent: string; redFlag: boolean }> {
  const cfg = getAiConfig();
  const sys =
    "你是牙科診所客服對話的標注助手。根據病人訊息（可能有前文）判斷兩樣嘢：\n" +
    `1. intent： BOOKING_REQUEST(約診) / QUESTION(問服務/費用/準備) / URGENT_PAIN(急痛) / PAIN(一般痛訴) / COMPLAINT(投訴) / OUT_OF_SCOPE(唔關牙樓事) / OTHER\n` +
    "2. redFlag：有冇紅旗情況（劇烈痛/腫/流血不止/發燒/術後異常/孕婦/免疫低下 等需要即時人手的）\n" +
    "只回 JSON：{\"intent\": \"...\", \"redFlag\": true|false}";
  const user =
    (contextBefore.length ? `前文：\n${contextBefore.map((c) => `- ${c}`).join("\n")}\n\n` : "") +
    `病人訊息：${utterance}`;
  try {
    const r = await chatWithFallback(cfg, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    });
    const m = r.content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`no json in llm response: ${r.content.slice(0, 120)}`);
    const parsed = JSON.parse(m[0]) as { intent?: string; redFlag?: boolean };
    return {
      intent: INTENTS.includes(parsed.intent ?? "") ? parsed.intent! : "OTHER",
      redFlag: Boolean(parsed.redFlag),
    };
  } catch (e) {
    // 預標 fail → OTHER + false（staff 審核時手改；唔阻塞批次）
    log.warn({ err: (e as Error).message }, "golden:sample prelabel fail → OTHER/false");
    return { intent: "OTHER", redFlag: false };
  }
}

async function main(): Promise<void> {
  const clinic = await prisma.clinic.findUnique({ where: { code: clinicArg! } });
  if (!clinic) {
    console.error(`clinic ${clinicArg} 唔存在`);
    process.exit(1);
  }
  const convs = await prisma.conversation.findMany({
    where: { clinicId: clinic.id },
    select: { id: true, contactId: true },
  });
  const msgs = await prisma.message.findMany({
    where: {
      conversationId: { in: convs.map((c) => c.id) },
      channel: "HISTORY",
      direction: "IN",
      type: "text",
      body: { not: null },
      waTimestamp: { gte: from },
    },
    orderBy: { waTimestamp: "asc" },
    select: { conversationId: true, body: true, waTimestamp: true },
  });
  // 每 conversation ≤2 句（最早）
  const perConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    const arr = perConv.get(m.conversationId) ?? [];
    if (arr.length < 2) {
      arr.push(m);
      perConv.set(m.conversationId, arr);
    }
  }
  const candidates: { conversationId: string; body: string }[] = [];
  for (const arr of perConv.values()) for (const m of arr) candidates.push({ conversationId: m.conversationId, body: m.body! });
  if (candidates.length === 0) {
    console.log("golden:sample — 0 候選（HISTORY/IN/text 無命中或 --from 太近）");
    return;
  }
  const limited = candidates.slice(0, limitArg);
  console.log(`golden:sample — ${candidates.length} 候選（每 conv ≤2 句），取 ${limited.length}（--limit）${dryRun ? " [dry-run]" : ""}`);

  // contact names（deid 用）
  const convById = new Map(convs.map((c) => [c.id, c]));
  const contactIds = [...new Set(limited.map((c) => convById.get(c.conversationId)?.contactId).filter(Boolean))] as string[];
  const contacts = await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, profileName: true } });
  const nameByContact = new Map(contacts.map((c) => [c.id, c.profileName]));

  // 冪等：已存在嘅 (clinicId, HISTORY_SAMPLE, utterance)
  const existing = await prisma.goldenCase.findMany({
    where: { clinicId: clinic.id, source: "HISTORY_SAMPLE" },
    select: { utterance: true },
  });
  const existingSet = new Set(existing.map((e) => e.utterance));

  let inserted = 0;
  let skipped = 0;
  let labeled = 0;
  for (const c of limited) {
    const contactId = convById.get(c.conversationId)?.contactId;
    const profileName = contactId ? nameByContact.get(contactId) : undefined;
    const names = profileName ? [profileName] : [];
    const utterance = deid(c.body, names);
    if (existingSet.has(utterance)) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      console.log(`  [dry] ${utterance.slice(0, 40)}`);
      continue;
    }
    const label = await preLabel(utterance, []);
    labeled += 1;
    await prisma.goldenCase.create({
      data: {
        clinicId: clinic.id,
        source: "HISTORY_SAMPLE",
        utterance,
        contextBefore: [],
        expectIntent: label.intent,
        expectRedFlag: label.redFlag,
        expectAutoOk: false,
        expectDocIds: [],
        enabled: false, // 未審核 — 唔入 eval
        note: "golden:sample 預標（staff 審核後啟用）",
      },
    });
    existingSet.add(utterance);
    inserted += 1;
  }
  console.log(`golden:sample 完成 — inserted=${inserted} skipped(dup)=${skipped} prelabeled=${labeled}${dryRun ? "（dry-run 未入庫）" : ""}`);
}

main().finally(() => prisma.$disconnect());
