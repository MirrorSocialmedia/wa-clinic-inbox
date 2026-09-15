/**
 * e2e-followup-p0 — cwi-followup-p0-20260915（S7）：W 側 e2e
 *
 * 測試（全過 exit 0，任何 fail exit 1）：
 *   T1 phoneHashes 多號 — 多號 → 多 hash + 去重 + 64-hex + 零 PII（純模組）
 *   T2 公司同步 3 公司映射 — 重置 sourceId → POST 同步 → A/B/C name-match 填 sourceId
 *      → CompanySyncRun 行 → 未配對 temp 公司留 null → pair API（409 衝突 + unpair）
 *   T3 字典下拉 — GET /api/dictionaries?kind=VISIT_REASON 完整清單
 *      → 規則 treatmentTypes 字典校驗（合法 200 / 唔合法 400 / PATCH 清空）
 *
 * 前置：dev server 127.0.0.1:3100 live；Postgres 15432；.env WORKFORCE_MOCK=1（決定性 mock）。
 * hub-a T350–T355 / hub-b T360–T370 迴歸另跑（e2e-hub-a.ts / e2e-hub-b.ts）。
 * 用法（repo root）：pnpm -s tsx scripts/e2e-followup-p0.ts
 */
const envPath = new URL("../.env", import.meta.url).pathname;
try {
  process.loadEnvFile(envPath);
} catch {
  /* 靠 process env */
}

const BASE = "http://127.0.0.1:3100";
const PASS = "Fup0-E2E-Pass-123!";
const ADMIN_ID = "e2efup0admin00000000000001"; // 25 lowercase alnum（cuid 形）
const TEMP_CO_ID = "e2efup0tmpco00000000000001";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✘ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function fail(name: string, detail?: unknown): never {
  check(name, false, detail);
  throw new Error(`fatal: ${name}`);
}

async function main(): Promise<void> {
  const { default: prisma } = await import("../src/lib/prisma");
  const { phoneHashes, normalizeHkPhones } = await import("../src/lib/phone-hash");
  const argon2 = (await import("argon2")) as { default: { hash: (p: string) => Promise<string> } };

  // ══ T1 phoneHashes 多號（純模組 — 同 CWM spec 對齊）══════════════════
  console.log("T1 phoneHashes 多號");
  const KEY = process.env.PHONE_HASH_KEY!;
  check("T1 key 已設（兩邊同值鐵律）", /^[a-f0-9]{16,}$/.test(KEY), KEY.slice(0, 8) + "…");
  const multi = "91234567,61234567,85291234567"; // 3 個写法 → 2 個 E.164（去重）
  check("T1 normalizeHkPhones 多號去重 → 2", normalizeHkPhones(multi).length === 2, normalizeHkPhones(multi));
  const hs = phoneHashes(multi);
  check("T1 phoneHashes → 2 hash（64-hex）", hs.length === 2 && hs.every((h) => /^[0-9a-f]{64}$/.test(h)), hs);
  check("T1 確定性", JSON.stringify(phoneHashes(multi)) === JSON.stringify(hs));
  check("T1 零 PII：hash 唔含原始號", hs.every((h) => !h.includes("91234567") && !h.includes("61234567")));
  check("T1 空 → []", phoneHashes("").length === 0 && phoneHashes(null).length === 0);

  // ══ fixture：admin 用戶 ═══════════════════════════════════════════════
  const oldUser = await prisma.staffUser.findUnique({ where: { id: ADMIN_ID }, select: { id: true } });
  if (oldUser) await prisma.staffUser.delete({ where: { id: ADMIN_ID } });
  await prisma.staffUser.create({
    data: {
      id: ADMIN_ID,
      email: "E2EFUP0-admin@example.com",
      name: "E2EFUP0 admin",
      role: "ADMIN",
      passwordHash: await argon2.default.hash(PASS),
      scopeType: "ALL",
      scopeCompanyId: null,
      active: true,
    },
  });

  // login（session cache — 只一次，rate limit 5/60s）
  const doLogin = async (): Promise<Response> =>
    fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "E2EFUP0-admin@example.com", password: PASS }),
    });
  let cookie = "";
  {
    // Next 15 dev loadManifest race → HTML 500 重試 3×3s（JSON 500 係真錯唔重試）
    let res = await doLogin();
    let body = await res.text();
    for (let i = 0; res.status === 500 && body.trimStart().startsWith("<") && i < 3; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      res = await doLogin();
      body = await res.text();
    }
    if (res.status !== 200) fail("T2 admin login", `${res.status} ${body.slice(0, 200)}`);
    cookie = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/)?.[1] ?? "";
    if (!cookie) fail("T2 admin login — 無 cookie");
  }
  const H = { cookie: `wa_inbox_session=${cookie}`, "content-type": "application/json" };

  // ══ T2 公司同步 3 公司映射 ═══════════════════════════════════════════
  console.log("T2 公司同步 3 公司映射");
  // reset（本 ticket 擁有 A/B/C sourceId 狀態）
  await prisma.company.updateMany({ where: { code: { in: ["A", "B", "C"] } }, data: { sourceId: null } });
  await prisma.company.deleteMany({ where: { id: TEMP_CO_ID } });

  const getSync = async () => {
    const r = await fetch(`${BASE}/api/admin/company-sync`, { headers: H });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  let g = await getSync();
  check("T2 GET sync 200", g.status === 200, g.body);
  const coBefore = Object.fromEntries((g.body.companies as any[]).map((c) => [c.code, c.sourceId]));
  check("T2 reset 後 A/B/C sourceId 全 null", coBefore.A === null && coBefore.B === null && coBefore.C === null, coBefore);

  const p = await fetch(`${BASE}/api/admin/company-sync`, { method: "POST", headers: H });
  const pb = (await p.json()) as any;
  check("T2 POST sync 200 ok", p.status === 200 && pb.ok === true, pb);
  check("T2 nameMatched=3", pb.nameMatched === 3, pb);

  g = await getSync();
  const coAfter = Object.fromEntries((g.body.companies as any[]).map((c) => [c.code, c.sourceId]));
  check("T2 A → fup0cmpa…001", coAfter.A === "fup0cmpa0000000000000000001", coAfter);
  check("T2 B → fup0cmpb…002", coAfter.B === "fup0cmpb0000000000000000002", coAfter);
  check("T2 C → fup0cmpc…003", coAfter.C === "fup0cmpc0000000000000000003", coAfter);
  const lastRun = g.body.lastRun;
  check("T2 lastRun ok（summary 有 companiesRemote=3）", lastRun?.status === "ok" && (lastRun.summary?.companiesRemote ?? 0) === 3, lastRun);
  const runCount = await prisma.companySyncRun.count();
  check("T2 CompanySyncRun 有落行", runCount >= 1, runCount);

  // 未配對 temp 公司
  await prisma.company.create({ data: { id: TEMP_CO_ID, code: "ZZ2", name: "E2EFUP0-TMP公司", sourceId: null } });
  const p2 = await fetch(`${BASE}/api/admin/company-sync`, { method: "POST", headers: H });
  const pb2 = (await p2.json()) as any;
  check("T2 sync #2 ok（temp 公司入 unmatchedLocal）", p2.status === 200 && pb2.ok === true && JSON.stringify(pb2.unmatchedLocal ?? []).includes(TEMP_CO_ID), pb2);
  g = await getSync();
  const tempRow = (g.body.companies as any[]).find((c) => c.id === TEMP_CO_ID);
  check("T2 temp 公司 sourceId 留 null（UI 紅字來源）", tempRow?.sourceId === null, tempRow);

  // pair API：衝突 409（fup0cmpa… 已被 A 佔）
  const pf1 = await fetch(`${BASE}/api/admin/company-sync/pair`, { method: "POST", headers: H, body: JSON.stringify({ companyId: TEMP_CO_ID, sourceId: "fup0cmpa0000000000000000001" }) });
  check("T2 pair 衝突 → 409", pf1.status === 409, await pf1.text().catch(() => ""));
  // pair unpair（sourceId=null 合法）
  const pf2 = await fetch(`${BASE}/api/admin/company-sync/pair`, { method: "POST", headers: H, body: JSON.stringify({ companyId: TEMP_CO_ID, sourceId: null }) });
  check("T2 pair unpair → 200", pf2.status === 200, await pf2.text().catch(() => ""));

  // ══ T3 字典下拉 ═══════════════════════════════════════════════════════
  console.log("T3 字典下拉");
  const d = await fetch(`${BASE}/api/dictionaries?kind=VISIT_REASON`, { headers: H });
  const db = (await d.json()) as any;
  check("T3 GET dictionaries 200", d.status === 200, db);
  check("T3 VISIT_REASON 完整清單（mock 2 項 0010/0021）", Array.isArray(db.items) && db.items.length === 2 && db.items.every((i: any) => "code" in i && "des" in i), db.items);

  const mkRule = (body: Record<string, unknown>) =>
    fetch(`${BASE}/api/admin/routing-rules`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: "E2EFUP0-tt-rule", clinicId: null, priority: 999, enabled: true, targetType: "CLINIC_POOL", ...body }),
    });
  const r1 = await mkRule({ treatmentTypes: [db.items[0].code] });
  const rb1 = (await r1.json()) as any;
  check("T3 建規則 treatmentTypes=合法 code → 201/200", r1.status === 200 || r1.status === 201, rb1);
  const ruleId = rb1.rule?.id ?? rb1.id;
  check("T3 規則有 id", typeof ruleId === "string" && ruleId.length > 0, rb1);

  const r2 = await mkRule({ name: "E2EFUP0-tt-rule-bad", treatmentTypes: ["9999"] });
  check("T3 treatmentTypes 唔喺字典 → 400", r2.status === 400, await r2.text().catch(() => ""));

  if (ruleId) {
    const r3 = await fetch(`${BASE}/api/admin/routing-rules/${ruleId}`, { method: "PATCH", headers: H, body: JSON.stringify({ treatmentTypes: [] }) });
    check("T3 PATCH 清空 treatmentTypes → 200", r3.status === 200, await r3.text().catch(() => ""));
    const list = await fetch(`${BASE}/api/admin/routing-rules`, { headers: H });
    const lb = (await list.json()) as any;
    const row = (lb.rules as any[]).find((x) => x.id === ruleId);
    check("T3 GET 列表 treatmentTypes 回傳（[]）", Array.isArray(row?.treatmentTypes) && row.treatmentTypes.length === 0, row);
  }

  // ══ cleanup（零殘留）═════════════════════════════════════════════════
  const delRule = await prisma.routingRule.deleteMany({ where: { name: { startsWith: "E2EFUP0-tt-rule" } } });
  const delTmpCo = await prisma.company.deleteMany({ where: { id: { in: [TEMP_CO_ID] } } });
  const delUser = await prisma.staffUser.deleteMany({ where: { id: ADMIN_ID } });
  check("cleanup 零殘留", delRule.count >= 1 && delTmpCo.count === 1 && delUser.count === 1, { delRule: delRule.count, delTmpCo: delTmpCo.count, delUser: delUser.count });
  const leftRules = await prisma.routingRule.count({ where: { name: { startsWith: "E2EFUP0-tt-rule" } } });
  const leftTmp = await prisma.company.count({ where: { id: TEMP_CO_ID } });
  check("cleanup 斷言：殘留 0", leftRules === 0 && leftTmp === 0, { leftRules, leftTmp });
}

main()
  .then(async () => {
    console.log(failures === 0 ? "\n[e2e-followup-p0] ALL PASS" : `\n[e2e-followup-p0] ${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("[e2e-followup-p0] FATAL", e);
    process.exit(1);
  });
