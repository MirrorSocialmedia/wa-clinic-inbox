/**
 * e2e-hub-a — ★ cwi-hub-a-20260914（Part A）：公司層範圍 ALL/COMPANY/CLINICS e2e。
 *
 * 用法（repo root）：pnpm -s tsx scripts/e2e-hub-a.ts
 * 前置：dev server 127.0.0.1:3100 live（web pnpm dev）；Postgres 15432。
 *
 * 測試（全過 exit 0，任何 fail exit 1）：
 *   T350 COMPANY 範圍（公司 B ADMIN）：clinic 列表只見 YMT/TW/MF；撳第四間（TY）→ 403
 *   T351 公司加新店 → 該公司 ADMIN 自動見到（唔使改 StaffClinic；cache 即時失效）
 *   T352 CLINICS 跨公司多選可行（TY[公司A] + TKW[公司C]）；外範圍店 → 403
 *   T353 舊 session（cookie 無 scopeType）fallback：ADMIN→ALL、STAFF→CLINICS
 *   T354 三計數不變式（unassigned/mine/routed + all）喺 ALL/COMPANY/CLINICS 都成立
 *   T355 用量統計按公司分組；COMPANY 範圍 ADMIN 只見自己公司
 *
 * Fixture 全部 `E2EHUBA-` 前綴；開工前冪等洗殘留；收結全清 + count=0 斷言（零殘留）。
 */
const envPath = new URL("../.env", import.meta.url).pathname;
try {
  process.loadEnvFile(envPath);
} catch {
  /* 靠 process env */
}

const BASE = "http://127.0.0.1:3100";
const PASS = "Huba-E2E-Pass-123!";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✘ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function fail(msg: string): never {
  console.error(`HUBA-ABORT: ${msg}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { prisma } = await import("../src/lib/prisma");
  const argon2 = (await import("argon2")) as { default: { hash: (p: string) => Promise<string> } };
  const { sealData, unsealData } = await import("iron-session");

  if (!process.env.SESSION_SECRET) fail("SESSION_SECRET missing（.env 冇？）");
  const SECRET = process.env.SESSION_SECRET;

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    fail(`DB ping 失敗：${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 基礎數據（生產映射 6 間 + 公司 3 間 — S0/S1 已入庫）────────────────
  const clinicId = async (code: string): Promise<string> => {
    const r = await prisma.clinic.findUnique({ where: { code }, select: { id: true } });
    if (!r) fail(`clinic ${code} 搵唔到（S0 fixture 未入庫？）`);
    return r.id;
  };
  const companyId = async (code: string): Promise<string> => {
    const r = await prisma.company.findUnique({ where: { code }, select: { id: true } });
    if (!r) fail(`company ${code} 搵唔到（S1 migration 未跑？）`);
    return r.id;
  };
  const [TY, YMT, TW, MF, TKW, WTC, YL] = await Promise.all(
    ["TY", "YMT", "TW", "MF", "TKW", "WTC", "YL"].map(clinicId)
  );
  const [CO_A, CO_B, CO_C] = await Promise.all(["A", "B", "C"].map(companyId));
  void WTC;
  void YL;

  // ── 冪等洗（上輪 crash 殘留 self-heal）──────────────────────────────
  const oldClinics = await prisma.clinic.findMany({ where: { code: { startsWith: "E2EHUBA-" } }, select: { id: true } });
  const oldUsers = await prisma.staffUser.findMany({ where: { email: { startsWith: "E2EHUBA-" } }, select: { id: true } });
  const oldClinicIds = oldClinics.map((c) => c.id);
  const oldUserIds = oldUsers.map((u) => u.id);
  const oldConvs = await prisma.conversation.findMany({
    where: { OR: [{ id: { startsWith: "E2EHUBA-" } }, { clinicId: { in: oldClinicIds } }] },
    select: { id: true },
  });
  const oldConvIds = oldConvs.map((c) => c.id);
  if (oldClinicIds.length || oldUserIds.length || oldConvIds.length) {
    console.log(`冪等洗：clinic ${oldClinicIds.length} / user ${oldUserIds.length} / conv ${oldConvIds.length}`);
  }
  // 註：Prisma 6 tagged $executeRaw 唔得 `IN ${array}`（$1 唔展開 — 實測）→ 用 client deleteMany（空 in:[] 安全）
  {
    const wc = oldConvIds;
    const wcl = oldClinicIds;
    const wu = oldUserIds;
    await prisma.message.deleteMany({ where: { OR: [{ id: { startsWith: "E2EHUBA-" } }, { conversationId: { in: wc } }] } });
    await prisma.bookingRequest.deleteMany({ where: { conversationId: { in: wc } } });
    await prisma.staffNotice.deleteMany({ where: { conversationId: { in: wc } } });
    await prisma.consultSession.deleteMany({ where: { conversationId: { in: wc } } });
    await prisma.flowSession.deleteMany({ where: { conversationId: { in: wc } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: wc } } });
    await prisma.conversation.deleteMany({ where: { id: { in: wc } } });
    await prisma.contact.deleteMany({ where: { OR: [{ id: { startsWith: "E2EHUBA-" } }, { clinicId: { in: wcl } }] } });
    await prisma.staffClinic.deleteMany({ where: { staffId: { in: wu } } });
    await prisma.staffUser.deleteMany({ where: { id: { in: wu } } });
    await prisma.clinic.deleteMany({ where: { id: { in: wcl } } });
  }

  // ── helpers ─────────────────────────────────────────────────────────
  // session cache（每個 email 只 login 一次 — login route 有 IP rate limiter，重復 login 會 429；
  //   cookie 係 stateless sealed — 同 session 跨 API 調用有效）
  const loginCache = new Map<string, string>();
  async function loginOnce(email: string): Promise<string> {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASS }),
    });
    const text = await res.text().catch(() => "");
    // 已知 Next 15 dev loadManifest race → HTML 500（lazy compile 高發；JSON 500 係真錯唔重試）
    // 重試 3 次 × 3s（dev .next 被 build 污染時重編譯 flood 會拉長 race 窗口 — 實測 1 次 2.5s 唔夠）
    let cookieVal: string | null = null;
    if (res.status === 500 && text.trimStart().startsWith("<")) {
      for (let att = 1; att <= 3; att++) {
        await new Promise((r) => setTimeout(r, 3000));
        const r2 = await fetch(`${BASE}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: PASS }),
        });
        const t2 = await r2.text().catch(() => "");
        if (r2.status === 200) {
          const m2 = (r2.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
          if (m2) {
            cookieVal = m2[1];
            break;
          }
        } else if (!(r2.status === 500 && t2.trimStart().startsWith("<"))) {
          fail(`login ${email} → ${r2.status} ${t2.slice(0, 200)}`);
        }
      }
      if (!cookieVal) fail(`login ${email} → 500 HTML×3（loadManifest race 持續）`);
      return cookieVal;
    }
    if (res.status === 429) {
      // IP rate limiter（5/60s）— 跨 section 重入窗口；等下重試一次
      await new Promise((r) => setTimeout(r, 6200));
      const res3 = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: PASS }),
      });
      if (res3.status !== 200) {
        const body3 = await res3.text().catch(() => "");
        fail(`login ${email} → ${res3.status} ${body3.slice(0, 200)}`);
      }
      const m3 = (res3.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
      if (!m3) fail(`login ${email} 冇 wa_inbox_session cookie`);
      return m3[1];
    }
    if (res.status !== 200) {
      fail(`login ${email} → ${res.status} ${text.slice(0, 200)}`);
    }
    const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
    if (!m) fail(`login ${email} 冇 wa_inbox_session cookie`);
    return m[1];
  }
  async function login(email: string): Promise<string> {
    const hit = loginCache.get(email);
    if (hit) return hit;
    const cookie = await loginOnce(email);
    loginCache.set(email, cookie);
    return cookie;
  }
  async function api(
    path: string,
    cookie: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; json: any }> {
    let attempt = 0;
    // do-while：已知 Next 15 dev loadManifest race → HTML 500 error page（無 request log；TOOLS.md 實測）。
    //   只重試 HTML body（race 特徵）— JSON 500（真 route 錯）唔重試，避免埋沒 bug。
    do {
      attempt++;
      const res = await fetch(`${BASE}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          cookie: `wa_inbox_session=${cookie}`,
          ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      const text = await res.text().catch(() => "");
      if (res.status === 500 && text.trimStart().startsWith("<") && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      return { status: res.status, json };
    } while (true);
  }
  const hash = async (): Promise<string> => argon2.default.hash(PASS);

  // 舊 session 偽造（iron-session v8 seal/unseal，同 server 相同 secret）
  async function stripScopeCookie(cookie: string): Promise<string> {
    const data = (await unsealData<Record<string, unknown>>(cookie, { password: SECRET })) ?? {};
    delete data.scopeType;
    delete data.scopeCompanyId;
    return sealData(data, { password: SECRET });
  }

  // 造 fixture 用戶（直接 DB — argon2 hash；active；無 TOTP）
  async function makeUser(
    id: string,
    email: string,
    role: "ADMIN" | "STAFF",
    scopeType: "ALL" | "COMPANY" | "CLINICS",
    scopeCompanyId: string | null,
  ): Promise<{ id: string; email: string }> {
    await prisma.staffUser.create({
      data: {
        id,
        email,
        name: id,
        role,
        passwordHash: await hash(),
        scopeType,
        scopeCompanyId,
        active: true,
      },
    });
    return { id, email };
  }
  async function addStaffClinic(staffId: string, clinicIdV: string): Promise<void> {
    await prisma.staffClinic.create({ data: { staffId, clinicId: clinicIdV } });
  }

  // ── fixture 用戶 ────────────────────────────────────────────────────
  const badmin = await makeUser("e2ehuba-badmin", "E2EHUBA-badmin@example.com", "ADMIN", "COMPANY", CO_B);
  const cross = await makeUser("e2ehuba-cross", "E2EHUBA-cross@example.com", "STAFF", "CLINICS", null);
  await addStaffClinic(cross.id, TY);
  await addStaffClinic(cross.id, TKW); // 跨公司（TY=A、TKW=C）
  const alladmin = await makeUser("e2ehuba-alladmin", "E2EHUBA-alladmin@example.com", "ADMIN", "ALL", null);
  const oldstaff = await makeUser("e2ehuba-oldstaff", "E2EHUBA-oldstaff@example.com", "STAFF", "CLINICS", null);
  await addStaffClinic(oldstaff.id, MF);
  // T355 專用：CLINICS scope 嘅 ADMIN（usage 係 requireAdmin — STAFF 403）
  const clinadmin = await makeUser("e2ehuba-clinadmin", "E2EHUBA-clinadmin@example.com", "ADMIN", "CLINICS", null);
  await addStaffClinic(clinadmin.id, TY);
  await addStaffClinic(clinadmin.id, TKW);

  console.log("fixture users 就緒");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T350] COMPANY 範圍（公司 B ADMIN）");
  const bCookie = await login(badmin.email);
  {
    const r = await api("/api/clinics?scope=schedule", bCookie);
    const codes = (r.json?.clinics ?? []).map((c: { code: string }) => c.code).sort();
    check("clinic 列表只返公司 B 三店", r.status === 200 && JSON.stringify(codes) === JSON.stringify(["MF", "TW", "YMT"]), codes);
    const ty = await api(`/api/conversations?clinicId=${TY}`, bCookie);
    check("撳第四間（TY，公司 A）→ 403", ty.status === 403, ty);
    const ymt = await api(`/api/conversations?clinicId=${YMT}`, bCookie);
    check("範圍內店（YMT）→ 200", ymt.status === 200, ymt.status);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T351] 公司加新店 → 該公司 ADMIN 自動見到");
  let newClinicId = "";
  {
    // badmin 經 API 開新診所歸公司 B（POST 內 invalidateClinicScopeCache — 同 process 即時）
    const createRes = await api("/api/admin/clinics", bCookie, {
      method: "POST",
      body: {
        code: "E2EHUBA-N",
        name: "e2e 公司加店",
        waPhoneNumberId: "e2ehuba-new-phone-0001",
        waDisplayNumber: "E2EHUBA-N-DSP", // schema 要求 min 1（顯示號）
        companyId: CO_B,
      },
    });
    if (createRes.status !== 200 && createRes.status !== 201) {
      check("API 開新診所歸公司 B", false, createRes);
    } else {
      const created = await prisma.clinic.findUnique({ where: { code: "E2EHUBA-N" }, select: { id: true, companyId: true } });
      check("新診所已建 + 歸公司 B", created?.companyId === CO_B, created);
      newClinicId = created?.id ?? "";
    }
    const r = await api("/api/clinics?scope=schedule", bCookie);
    const codes = (r.json?.clinics ?? []).map((c: { code: string }) => c.code).sort();
    check(
      "加店後公司 B ADMIN 即時見 4 間（唔使改 StaffClinic）",
      r.status === 200 && JSON.stringify(codes) === JSON.stringify(["E2EHUBA-N", "MF", "TW", "YMT"]),
      codes,
    );
    const aCookie = await login(alladmin.email);
    const ra = await api("/api/clinics?scope=schedule", aCookie);
    const codesA = (ra.json?.clinics ?? []).map((c: { code: string }) => c.code);
    check("ALL scope ADMIN 亦見到新診所", ra.status === 200 && codesA.includes("E2EHUBA-N"), codesA);
    // 清理（DELETE 先會再 invalidate cache — 還原 3 間形態俾後續測試）
    if (newClinicId) {
      const del = await api(`/api/admin/clinics/${newClinicId}`, bCookie, { method: "DELETE" });
      check("清理新診所", del.status === 200 || del.status === 204, del.status);
    }
    const after = await api("/api/clinics?scope=schedule", bCookie);
    const codesAfter = (after.json?.clinics ?? []).map((c: { code: string }) => c.code).sort();
    check("刪店後還原 3 間（cache 失效正常）", JSON.stringify(codesAfter) === JSON.stringify(["MF", "TW", "YMT"]), codesAfter);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T352] CLINICS 跨公司多選");
  const xCookie = await login(cross.email);
  {
    const rTy = await api(`/api/conversations?clinicId=${TY}`, xCookie);
    const rTkw = await api(`/api/conversations?clinicId=${TKW}`, xCookie);
    const rMf = await api(`/api/conversations?clinicId=${MF}`, xCookie);
    check("TY（公司 A）→ 200", rTy.status === 200, rTy.status);
    check("TKW（公司 C）→ 200（跨公司可行）", rTkw.status === 200, rTkw.status);
    check("MF（公司 B，外範圍）→ 403", rMf.status === 403, rMf.status);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T353] 舊 session（無 scopeType）fallback");
  {
    // ADMIN：新 session 有 scopeType=ALL → strip 之後 fallback 仍 = ALL
    const aNew = await login(alladmin.email);
    const fresh = await unsealData<Record<string, unknown>>(aNew, { password: SECRET });
    check("新 session 帶 scopeType=ALL", fresh?.scopeType === "ALL", Object.keys(fresh ?? {}));
    const aOld = await stripScopeCookie(aNew);
    const ra = await api(`/api/conversations?clinicId=${TY}`, aOld);
    check("舊 session ADMIN → ALL：可見公司 A 嘅 TY", ra.status === 200, ra.status);
    const raClinics = await api("/api/clinics?scope=schedule", aOld);
    const codesA = (raClinics.json?.clinics ?? []).map((c: { code: string }) => c.code);
    check("舊 session ADMIN → ALL：clinic 列表全 7 間", codesA.length === 7, codesA);

    // STAFF：fallback = CLINICS（session clinicIds 快照 = StaffClinic 集合 [MF]）
    const sNew = await login(oldstaff.email);
    const sOld = await stripScopeCookie(sNew);
    const rsMf = await api(`/api/conversations?clinicId=${MF}`, sOld);
    const rsTkw = await api(`/api/conversations?clinicId=${TKW}`, sOld);
    check("舊 session STAFF → CLINICS：MF（StaffClinic 內）→ 200", rsMf.status === 200, rsMf.status);
    check("舊 session STAFF → CLINICS：TKW（外）→ 403", rsTkw.status === 403, rsTkw.status);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T354] 三計數不變式（ALL / COMPANY / CLINICS）");
  // fixture 對話（deterministic — 令計數非平凡）：
  //   c-mf   MF   unassigned OPEN      → 只在 badmin/alladmin scope
  //   c-ty   TY   unassigned OPEN      → 只在 cross/alladmin scope
  //   c-tkw  TKW  unassigned OPEN      → 只在 cross/alladmin scope
  //   c-ymt  YMT  OPEN assignee=cross  → badmin（clinic 支路）/ cross（assignee 支路）/ all
  //   c-wtc  WTC  RESOLVED             → all（resolved 計數）；badmin/cross 無
  //   c-ty2  TY   OPEN routedStaffId=cross → cross 的 routed=1 / all=1 / badmin=0
  let convSeq = 0;
  async function makeConv(id: string, clinicIdV: string, extra: Record<string, unknown> = {}): Promise<string> {
    convSeq++;
    const contactId = `${id}-contact`;
    await prisma.contact.create({
      data: {
        id: contactId,
        clinicId: clinicIdV,
        waId: `852800${1000 + convSeq}`,
        profileName: null,
        labels: [],
      },
    });
    await prisma.conversation.create({
      data: {
        id,
        clinicId: clinicIdV,
        contactId,
        lastMessageAt: new Date(),
        ...extra,
      },
    });
    return id;
  }
  await makeConv("E2EHUBA-c-mf", MF);
  await makeConv("E2EHUBA-c-ty", TY);
  await makeConv("E2EHUBA-c-tkw", TKW);
  await makeConv("E2EHUBA-c-ymt", YMT, { assigneeId: cross.id });
  await makeConv("E2EHUBA-c-wtc", WTC, { status: "RESOLVED" });
  await makeConv("E2EHUBA-c-ty2", TY, { routedStaffId: cross.id });
  {
    const scopeSets: Record<string, string[] | null> = {
      ALL: null,
      COMPANY_B: null, // 下面由 DB 算
      CLINICS_X: [TY, TKW],
    };
    const bClinics = await prisma.clinic.findMany({ where: { companyId: CO_B }, select: { id: true } });
    scopeSets.COMPANY_B = bClinics.map((c) => c.id);

    const users = [
      { name: "ALL", cookie: await login(alladmin.email), uid: alladmin.id, set: scopeSets.ALL },
      { name: "COMPANY_B", cookie: await login(badmin.email), uid: badmin.id, set: scopeSets.COMPANY_B },
      { name: "CLINICS_X", cookie: await login(cross.email), uid: cross.id, set: scopeSets.CLINICS_X },
    ];

    for (const u of users) {
      const r = await api("/api/conversations?counts=1", u.cookie);
      const counts = r.json?.counts;
      check(`${u.name}: counts=1 200`, r.status === 200 && !!counts, r.status);
      if (!counts) continue;

      // DB 不變式（同一 buildScope 語義：S=null → 全店；否則 OR[clinicId∈S, assigneeId=me]）
      const scopeW: Record<string, unknown> = u.set ? { OR: [{ clinicId: { in: u.set } }, { assigneeId: u.uid }] } : {};
      const notRes = { status: { not: "RESOLVED" as const } };
      const [dbAll, dbUnassigned, dbMine, dbRouted] = await Promise.all([
        prisma.conversation.count({ where: { ...scopeW, ...notRes } }),
        prisma.conversation.count({ where: { ...scopeW, ...notRes, assigneeId: null } }),
        prisma.conversation.count({ where: { ...scopeW, ...notRes, assigneeId: u.uid } }),
        prisma.conversation.count({ where: { AND: [scopeW, notRes, { assigneeId: null, routedStaffId: u.uid }] } }),
      ]);
      check(`${u.name}: all == DB（${dbAll}）`, counts.all === dbAll, { api: counts, db: dbAll });
      check(`${u.name}: unassigned == DB（${dbUnassigned}）`, counts.unassigned === dbUnassigned, { api: counts, db: dbUnassigned });
      check(`${u.name}: mine == DB（${dbMine}）`, counts.mine === dbMine, { api: counts, db: dbMine });
      check(`${u.name}: routed == DB（${dbRouted}）`, counts.routed === dbRouted, { api: counts, db: dbRouted });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T355] 用量統計按公司分組");
  // 造本月 OUT API 訊息：TY / YMT / TKW 各 1 條（SERVICE）
  const msgClinics: [string, string][] = [
    ["E2EHUBA-m-ty", TY],
    ["E2EHUBA-m-ymt", YMT],
    ["E2EHUBA-m-tkw", TKW],
  ];
  for (const [convId, clinicIdV] of msgClinics) {
    await makeConv(convId, clinicIdV);
    await prisma.message.create({
      data: {
        id: `${convId}-msg`,
        conversationId: convId,
        direction: "OUT",
        channel: "API",
        type: "text",
        body: "e2e huba usage",
        status: "SENT",
        billingCategory: "SERVICE",
        waTimestamp: new Date(),
        sentByStaffId: alladmin.id,
      },
    });
  }
  {
    const HK_OFFSET_MS = 8 * 3_600_000;
    const DAY_MS = 86_400_000;
    const nowT = Date.now();
    const t = nowT + HK_OFFSET_MS;
    const hkDay = Math.floor(t / DAY_MS);
    const dow = new Date(hkDay * DAY_MS).getUTCDay();
    const sinceMon = (dow + 6) % 7;
    const weekLo = new Date((hkDay - sinceMon) * DAY_MS - HK_OFFSET_MS); // 本週週一 00:00 HK
    const weekHi = new Date((hkDay - sinceMon + 7) * DAY_MS - HK_OFFSET_MS);
    const monthLo = ((): Date => {
      const hk = new Date(t);
      return new Date(Date.UTC(hk.getUTCFullYear(), hk.getUTCMonth(), 1) - HK_OFFSET_MS);
    })();

    const usageExpect = async (clinicIds: string[] | null) => {
      const rows = await prisma.$queryRawUnsafe<
        { clinicCode: string; category: string | null; total: number }[]
      >(
        `SELECT c.code AS "clinicCode", m."billingCategory" AS category, count(*)::int AS total
           FROM "Message" m
           JOIN "Conversation" cv ON cv.id = m."conversationId"
           JOIN "Clinic" c ON c.id = cv."clinicId"
          WHERE m.direction = 'OUT' AND m.channel = 'API'
            AND m."createdAt" >= $1
            AND (${clinicIds ? "c.id = ANY($2::text[])" : "true"})
          GROUP BY 1, 2`,
        ...(clinicIds ? [monthLo, clinicIds] : [monthLo])
      );
      const weekTotal = (
        await prisma.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n
             FROM "Message" m
             JOIN "Conversation" cv ON cv.id = m."conversationId"
             JOIN "Clinic" c ON c.id = cv."clinicId"
            WHERE m.direction = 'OUT' AND m.channel = 'API'
              AND m."createdAt" >= $1 AND m."createdAt" < $2
              AND (${clinicIds ? "c.id = ANY($3::text[])" : "true"})`,
          ...(clinicIds ? [weekLo, weekHi, clinicIds] : [weekLo, weekHi])
        )
      )[0]?.n ?? 0;
      return { rows, weekTotal };
    };

    const cases = [
      { name: "ALL", cookie: await login(alladmin.email), set: null as string[] | null, expectCompanies: ["A", "B", "C"] },
      {
        name: "COMPANY_B",
        cookie: await login(badmin.email),
        set: (await prisma.clinic.findMany({ where: { companyId: CO_B }, select: { id: true } })).map((c) => c.id),
        expectCompanies: ["B"],
      },
      { name: "CLINICS_X", cookie: await login(clinadmin.email), set: [TY, TKW], expectCompanies: [] as string[] },
    ];

    for (const cse of cases) {
      const r = await api("/api/admin/usage", cse.cookie);
      check(`${cse.name}: /api/admin/usage 200`, r.status === 200, r.status);
      if (r.status !== 200) continue;
      const body = r.json;
      const exp = await usageExpect(cse.set);
      // rows 對齊（clinicCode × category → total 多重集合）
      const key = (x: { clinicCode: string; category: string | null }) => `${x.clinicCode}|${x.category ?? "null"}`;
      const apiMap = new Map<string, number>();
      for (const row of body.rows ?? []) apiMap.set(key(row), (apiMap.get(key(row)) ?? 0) + row.total);
      const expMap = new Map<string, number>();
      for (const row of exp.rows) expMap.set(key(row), (expMap.get(key(row)) ?? 0) + row.total);
      const same =
        apiMap.size === expMap.size && [...expMap.entries()].every(([k, v]) => apiMap.get(k) === v);
      check(`${cse.name}: rows == DB 範圍內聚合`, same, { api: [...apiMap], db: [...expMap] });
      // 公司分組
      const coCodes = (body.companies ?? []).map((c: { code: string }) => c.code).sort();
      if (cse.name !== "CLINICS_X") {
        check(`${cse.name}: companies == ${cse.expectCompanies.join("/")}`, JSON.stringify(coCodes) === JSON.stringify([...cse.expectCompanies].sort()), coCodes);
      } else {
        // CLINICS（TY=A、TKW=C）→ 涉及公司 A + C
        check(`${cse.name}: companies == A/C（指定診所涉及公司）`, JSON.stringify(coCodes) === JSON.stringify(["A", "C"]), coCodes);
      }
      // 週趨勢（本週）== DB 範圍內本週 OUT API 數
      const cur = (body.weekTrend ?? []).find((w: { current: boolean }) => w.current);
      check(`${cse.name}: 本週趨勢 == DB（${exp.weekTotal}）`, cur?.total === exp.weekTotal, { api: cur?.total, db: exp.weekTotal });
    }
    // STAFF 唔准入 usage
    const rStaff = await api("/api/admin/usage", xCookie);
    check("STAFF → /api/admin/usage 403", rStaff.status === 403, rStaff.status);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[收結] 零殘留清理");
  {
    const clinicIds = (await prisma.clinic.findMany({ where: { code: { startsWith: "E2EHUBA-" } }, select: { id: true } })).map((c) => c.id);
    const userIds = (await prisma.staffUser.findMany({ where: { email: { startsWith: "E2EHUBA-" } }, select: { id: true } })).map((u) => u.id);
    const convIds = (
      await prisma.conversation.findMany({
        where: { OR: [{ id: { startsWith: "E2EHUBA-" } }, { clinicId: { in: clinicIds } }] },
        select: { id: true },
      })
    ).map((c) => c.id);
    {
      await prisma.message.deleteMany({ where: { OR: [{ id: { startsWith: "E2EHUBA-" } }, { conversationId: { in: convIds } }] } });
      await prisma.bookingRequest.deleteMany({ where: { conversationId: { in: convIds } } });
      await prisma.staffNotice.deleteMany({ where: { conversationId: { in: convIds } } });
      await prisma.consultSession.deleteMany({ where: { conversationId: { in: convIds } } });
      await prisma.flowSession.deleteMany({ where: { conversationId: { in: convIds } } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: convIds } } });
      await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
      await prisma.contact.deleteMany({ where: { OR: [{ id: { startsWith: "E2EHUBA-" } }, { clinicId: { in: clinicIds } }] } });
      await prisma.staffClinic.deleteMany({ where: { staffId: { in: userIds } } });
      await prisma.staffUser.deleteMany({ where: { id: { in: userIds } } });
      await prisma.clinic.deleteMany({ where: { id: { in: clinicIds } } });
    }

    const left = await Promise.all([
      prisma.staffUser.count({ where: { email: { startsWith: "E2EHUBA-" } } }),
      prisma.clinic.count({ where: { code: { startsWith: "E2EHUBA-" } } }),
      prisma.conversation.count({ where: { id: { startsWith: "E2EHUBA-" } } }),
      prisma.contact.count({ where: { id: { startsWith: "E2EHUBA-" } } }),
      prisma.message.count({ where: { id: { startsWith: "E2EHUBA-" } } }),
    ]);
    check("殘留 = 0（user/clinic/conv/contact/msg）", left.every((n) => n === 0), left);
  }

  if (failures > 0) {
    console.error(`\nHUBA-E2E: ${failures} 項失敗`);
    process.exit(1);
  }
  console.log("\nHUBA-E2E: 全部通過 ✔");
  process.exit(0);
}

main().catch((e) => {
  console.error("HUBA-E2E 未捕獲錯誤：", e);
  process.exit(1);
});
