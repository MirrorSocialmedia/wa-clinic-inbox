/**
 * e2e-t750-quotes-scope — cwi-final S0-7：報價隊列 scope + D-5 教字典（audit3 P0-09 → P1）
 *
 * T750（施工單）：TY STAFF GET → 只有 TY；POST YMT 報價 → 403；
 *                 SUPERVISOR POST → 403；COMPANY ADMIN 帶 teachTerm → 200 + teachTermIgnored:true
 * 附加正例：GROUP ADMIN（ALL）帶 teachTerm → 200 + teachTermIgnored:false + mock 真係教到字典；
 *           SUPERVISOR GET → 全店（唯讀語義）。
 *
 * 背景：舊 route 只 requireAuth — 任何 staff 睇全集團報價 + 決定任何店報價；
 * SUPERVISOR（唯讀角色）可決定；任何角色 teachTerm 都直送 CWM 字典。
 *
 * fixture：.dev/workforce-mock-clinical.json symlink swap（TY ×2 + YMT ×1 報價），
 *   **全程 try/finally 還原**（setup 失敗都還原）+ DB 4 用戶（TY STAFF / SUPERVISOR / COMPANY ADMIN / GROUP ADMIN）。
 *
 * 用法（repo root）：pnpm tsx scripts/e2e-t750-quotes-scope.ts
 * 輸出：T750-OK / T750-FAIL: <n>
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

const require = createRequire(path.join(process.cwd(), "package.json"));
const argon2 = require("argon2");

try {
  process.loadEnvFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"));
} catch {
  /* 靠 process env */
}

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const PASS = "T750-E2E-Pass-789!";
const MOCK_FLAG = path.resolve(process.cwd(), ".dev/workforce-mock-clinical.json");
const MOCK_REAL = "/tmp/e2et750-clinical-mock.json";

const U_TY = "e2et750typ00000000000001";
const U_SUP = "e2et750sup00000000000001";
const U_CO = "e2et750co00000000000001";
const U_GR = "e2et750gr00000000000001";
const E_TY = "e2et750ty@e2e.local";
const E_SUP = "e2et750sup@e2e.local";
const E_CO = "e2et750co@e2e.local";
const E_GR = "e2et750gr@e2e.local";

const Q_TY_0 = "q750-ty-0";
const Q_TY_1 = "q750-ty-1";
const Q_YMT_0 = "q750-ymt-0";
const USER_IDS = [U_TY, U_SUP, U_CO, U_GR];

let FAILS = 0;
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(name);
  else fail(`${name}${detail !== undefined ? "（" + JSON.stringify(detail).slice(0, 300) + "）" : ""}`);
}

const prisma = new PrismaClient();

const qrow = (id: string, clinicCode: string, status: string) => ({
  id,
  patientApricotId: `cp750-${id.slice(-2)}`,
  clinicCode,
  sourceVisitDate: "2026-09-10",
  text: "T750 e2e 報價項目（零臨床）",
  termShorthand: null,
  nameCn: null,
  amountMin: 1000,
  amountMax: null,
  perUnit: false,
  fdiTeeth: [],
  intent: "not_done",
  certainty: "low",
  source: "parser",
  status,
});

async function main(): Promise<void> {
  console.log("[setup] mock fixture swap + seed...");
  let hadFlag = false;
  let origTarget: string | null = null;
  // ★ 全程 try/finally：setup 段失敗都必還原 mock symlink + 清 DB 用戶
  try {
    // ── mock fixture（save/swap symlink）─────────────────────────
    if (fs.existsSync(MOCK_FLAG)) {
      hadFlag = true;
      origTarget = fs.readlinkSync(MOCK_FLAG);
      fs.unlinkSync(MOCK_FLAG);
    }
    fs.writeFileSync(
      MOCK_REAL,
      JSON.stringify(
        {
          quotes: [qrow(Q_TY_0, "TY", "pending"), qrow(Q_TY_1, "TY", "confirmed"), qrow(Q_YMT_0, "YMT", "pending")],
          terms: [
            { id: "t750-br", shorthand: "br", nameCn: "牙橋", nameEn: "Bridge", usedFor: ["quote_extraction"], active: true, updatedAt: new Date().toISOString() },
          ],
        },
        null,
        2
      )
    );
    fs.symlinkSync(MOCK_REAL, MOCK_FLAG);

    // ── DB users ─────────────────────────────────────────────────
    await prisma.staffClinic.deleteMany({ where: { staffId: { in: USER_IDS } } });
    await prisma.staffUser.deleteMany({ where: { id: { in: USER_IDS } } });
    const clinics = await prisma.$queryRawUnsafe<{ id: string; code: string }[]>(
      `SELECT id, code FROM "Clinic" WHERE code IN ('TY','YMT') ORDER BY code`
    );
    const tyClinic = clinics.find((c) => c.code === "TY");
    const ymtClinic = clinics.find((c) => c.code === "YMT");
    if (!tyClinic || !ymtClinic) {
      throw new Error(`TY/YMT clinic 搵唔齊：${JSON.stringify(clinics)}`);
    }
    const pwHash = await argon2.hash(PASS);
    const mkUser = async (id: string, email: string, role: "STAFF" | "SUPERVISOR" | "ADMIN", scopeType: "CLINICS" | "ALL"): Promise<void> => {
      await prisma.staffUser.upsert({
        where: { id },
        update: { active: true, scopeType: scopeType as never },
        create: { id, email, name: `E2E T750 ${role}`, passwordHash: pwHash, role, active: true, scopeType: scopeType as never },
      });
      if (scopeType === "CLINICS") {
        await prisma.staffClinic.create({ data: { staffId: id, clinicId: tyClinic.id, isPrimary: true } });
      }
    };
    await mkUser(U_TY, E_TY, "STAFF", "CLINICS");
    await mkUser(U_SUP, E_SUP, "SUPERVISOR", "ALL");
    await mkUser(U_CO, E_CO, "ADMIN", "CLINICS"); // COMPANY ADMIN（TY 店級 ADMIN）
    await mkUser(U_GR, E_GR, "ADMIN", "ALL"); // 全集團 ADMIN
    ok(`fixture：mock 3 報價（TY×2 + YMT×1）+ 4 用戶（TY=${tyClinic.id.slice(0, 8)}… YMT=${ymtClinic.id.slice(0, 8)}…）`);

    const login = async (email: string): Promise<string> => {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: PASS }),
      });
      if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
      const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
      if (!m) throw new Error("login 冇 cookie");
      return m[1];
    };
    const [ckTy, ckSup, ckCo, ckGr] = await Promise.all([login(E_TY), login(E_SUP), login(E_CO), login(E_GR)]);

    const api = async (cookie: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
      const url = `${BASE}/api/admin/quotes${init?.method ? "" : "?status=pending,confirmed,corrected&limit=10"}`;
      const res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", Cookie: `wa_inbox_session=${cookie}` },
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* non-json */
      }
      return { status: res.status, body };
    };

    // ── a) TY STAFF GET → 只有 TY ─────────────────────────────────
    const g1 = await api(ckTy);
    const codes = (g1.body?.quotes ?? []).map((q: any) => q.clinicCode);
    check("T750a TY STAFF GET 200", g1.status === 200, g1.status);
    check("T750a 全部報價 = TY（零 YMT）", codes.length === 2 && codes.every((c: string) => c === "TY"), codes);

    // ── b) TY STAFF POST YMT 報價 → 403 ───────────────────────────
    const p1 = await api(ckTy, { method: "POST", body: JSON.stringify({ id: Q_YMT_0, action: "discard" }) });
    check("T750b TY STAFF 決定 YMT 報價 → 403", p1.status === 403, p1);
    const ymtAfter = (await api(ckSup)).body?.quotes.find((q: any) => q.id === Q_YMT_0); // SUPERVISOR 全店口徑核（TY STAFF scope 內本看不到 YMT）
    check("T750b YMT 報價狀態未變（pending）", ymtAfter?.status === "pending", ymtAfter);

    // ── c) SUPERVISOR POST → 403（唯讀）──────────────────────────
    const p2 = await api(ckSup, { method: "POST", body: JSON.stringify({ id: Q_TY_0, action: "confirm" }) });
    check("T750c SUPERVISOR POST → 403", p2.status === 403, p2);
    const supGet = await api(ckSup);
    const supCodes = (supGet.body?.quotes ?? []).map((q: any) => q.clinicCode);
    check("T750c（附加）SUPERVISOR GET 全店（TY+YMT 都見到）", supCodes.includes("TY") && supCodes.includes("YMT"), supCodes);

    // ── d) COMPANY ADMIN 帶 teachTerm → 200 + teachTermIgnored:true ─
    const p3 = await api(ckCo, {
      method: "POST",
      body: JSON.stringify({ id: Q_TY_0, action: "confirm", teachTerm: { shorthand: "t750co", nameCn: "公司級術語", usedFor: ["quote_extraction"] } }),
    });
    check(
      "T750d COMPANY ADMIN teachTerm → 200 + teachTermIgnored:true（termMapUpserted:false）",
      p3.status === 200 && p3.body?.teachTermIgnored === true && p3.body?.termMapUpserted === false,
      p3
    );
    const coTerm = JSON.parse(fs.readFileSync(MOCK_REAL, "utf8")).terms ?? [];
    check("T750d mock 字典零新增（teachTerm 冇送落）", !coTerm.some((t: any) => t.shorthand === "t750co"), coTerm.map((t: any) => t.shorthand));

    // ── e) GROUP ADMIN 帶 teachTerm → 200 + teachTermIgnored:false ─
    const p4 = await api(ckGr, {
      method: "POST",
      body: JSON.stringify({
        id: Q_TY_1,
        action: "correct",
        fields: { amountMin: 2000 },
        correctionNote: "金額改",
        teachTerm: { shorthand: "t750gr", nameCn: "集團級術語", usedFor: ["quote_extraction"] },
      }),
    });
    check(
      "T750e GROUP ADMIN teachTerm → 200 + teachTermIgnored:false + termMapUpserted:true",
      p4.status === 200 && p4.body?.teachTermIgnored === false && p4.body?.termMapUpserted === true,
      p4
    );
    const grTerms = JSON.parse(fs.readFileSync(MOCK_REAL, "utf8")).terms ?? [];
    check("T750e mock 字典真係新增（t750gr）", grTerms.some((t: any) => t.shorthand === "t750gr" && t.nameCn === "集團級術語"), grTerms.map((t: any) => t.shorthand));
  } finally {
    // ── restore mock symlink + cleanup DB（setup 失敗都行呢度）────
    try {
      if (fs.existsSync(MOCK_FLAG)) fs.unlinkSync(MOCK_FLAG);
      if (hadFlag && origTarget) fs.symlinkSync(origTarget, MOCK_FLAG);
    } catch {
      /* best-effort */
    }
    try {
      await prisma.staffClinic.deleteMany({ where: { staffId: { in: USER_IDS } } });
      await prisma.staffUser.deleteMany({ where: { id: { in: USER_IDS } } });
      const leftover = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT ((SELECT count(*) FROM "StaffUser" WHERE id IN ('${U_TY}','${U_SUP}','${U_CO}','${U_GR}'))
          + (SELECT count(*) FROM "StaffClinic" WHERE "staffId" IN ('${U_TY}','${U_SUP}','${U_CO}','${U_GR}')))::int AS n`
      );
      check("cleanup 後零殘留", leftover[0]?.n === 0);
    } catch (e) {
      fail(`cleanup 異常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (FAILS > 0) {
    console.log(`T750-FAIL: ${FAILS} 項失敗`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("T750-OK");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("T750-FAIL:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
