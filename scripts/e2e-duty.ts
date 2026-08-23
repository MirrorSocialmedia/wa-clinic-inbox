/**
 * e2e-duty — duty-roster 消費端 in-process 測試（E2E T38 用）。
 *
 * 直擊 route handler（GET）+ client（fetchDutyRoster / sanitizeDutyPayload）—
 * 唔使重啟 server（env DUTY_MOCK / DUTY_API_URL 喺 request 時先讀，可以 per-process 控制）。
 *
 * 用法（repo root）：
 *   pnpm e2e:duty --cookie /tmp/e2e-cookie-tkw.txt        # mock fixture + RBAC 403 + whitelist
 *   pnpm e2e:duty --cookie /tmp/e2e-cookie-tkw.txt --down # DUTY_MOCK=0 + 無/壞 URL → 200 {duty:null} 唔 crash
 *
 * 斷言輸出（mock-e2e.sh grep 用）：
 *   DUTY-WHITELIST-OK / DUTY-WHITELIST-FAIL
 *   DUTY-MOCK-OK / DUTY-MOCK-FAIL（+ DUTY-HTTP= DUTY-COUNT=）
 *   DUTY-403-OK / DUTY-403-FAIL
 *   DUTY-DOWN-OK / DUTY-DOWN-FAIL
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import prisma from "../src/lib/prisma";
import { sanitizeDutyPayload, __resetDutyCache } from "../src/lib/duty/client";
import { GET } from "../src/app/api/duty-roster/route";

async function main() {
  const cookieFile = (process.argv.find((a, i) => process.argv[i - 1] === "--cookie") ?? "").trim();
  const downMode = process.argv.includes("--down");

  let cookieValue = "";
  if (cookieFile) {
    // cookie jar 格式：... wa_inbox_session <value>
    const lines = await readFile(cookieFile, "utf8");
    const line = lines.split("\n").find((l) => l.includes("wa_inbox_session"));
    cookieValue = (line ?? "").trim().split(/\s+/).pop() ?? "";
  }
  if (!cookieValue) {
    console.error("FAIL: 搵唔到 wa_inbox_session cookie（--cookie 路徑？）");
    process.exit(1);
  }

  const mkReq = (path: string): NextRequest =>
    new NextRequest(`http://127.0.0.1${path}`, {
      headers: { cookie: `wa_inbox_session=${cookieValue}` },
    });

  let fail = 0;

  // ── whitelist sanitize（純函數斷言：多餘欄位全部丟） ─────────────────────
  const raw = [
    { staffName: "A", role: "前台", shiftStart: "09:00", shiftEnd: "17:00", payroll: "50000", clockIn: "08:59", id: "x1" },
    { staffName: "B", role: "護士", shiftStart: "bad-time", shiftEnd: "18:00" }, // 壞 shift → 整 row 丟
    "not-an-object",
  ];
  const sanitized = sanitizeDutyPayload(raw);
  const whitelistOk =
    Array.isArray(sanitized) &&
    sanitized.length === 1 &&
    sanitized[0].staffName === "A" &&
    Object.keys(sanitized[0]).sort().join(",") === "role,shiftEnd,shiftStart,staffName";
  console.log(whitelistOk ? "DUTY-WHITELIST-OK" : `DUTY-WHITELIST-FAIL ${JSON.stringify(sanitized)}`);
  if (!whitelistOk) fail = 1;

  if (downMode) {
    // ── down 路徑：DUTY_MOCK=0 + 無 URL / 壞 URL → 200 {duty:null} 唔 crash ──
    // ★ workforce 切換後（0db0f61）duty client 改經 WORKFORCE_API_URL — 舊 DUTY_API_URL
    //   已無人讀；down 場景要搣 WORKFORCE_API_URL 先真正打唔到（.env 預設指 workforce mock）。
    process.env.DUTY_MOCK = "0";
    delete process.env.DUTY_API_URL;
    delete process.env.DUTY_API_KEY;
    delete process.env.WORKFORCE_API_URL;
    process.env.WORKFORCE_MOCK = "0"; // .env 預設 =1（client fetch 前就返 fixture）— down 場景要關
    __resetDutyCache();

    const resNoUrl = await GET(mkReq("/api/duty-roster?clinicId=TKW"), { params: Promise.resolve({}) });
    const bodyNoUrl = (await resNoUrl.json().catch(() => null)) as { duty?: unknown } | null;
    const noUrlOk = resNoUrl.status === 200 && bodyNoUrl?.duty === null;
    console.log(
      noUrlOk
        ? "DUTY-DOWN-OK (no URL → 200 {duty:null})"
        : `DUTY-DOWN-FAIL (no URL → ${resNoUrl.status} ${JSON.stringify(bodyNoUrl)})`
    );
    if (!noUrlOk) fail = 1;

    // 壞 URL（closed port）→ conn-refused → 200 {duty:null}
    process.env.WORKFORCE_API_URL = "http://127.0.0.1:59999";
    __resetDutyCache();
    const resBad = await GET(mkReq("/api/duty-roster?clinicId=TKW"), { params: Promise.resolve({}) });
    const bodyBad = (await resBad.json().catch(() => null)) as { duty?: unknown } | null;
    const badOk = resBad.status === 200 && bodyBad?.duty === null;
    console.log(
      badOk
        ? "DUTY-DOWN-OK (dead URL → 200 {duty:null})"
        : `DUTY-DOWN-FAIL (dead URL → ${resBad.status} ${JSON.stringify(bodyBad)})`
    );
    if (!badOk) fail = 1;

    await prisma.$disconnect();
    process.exit(fail);
  }

  // ── 正常路徑：mock fixture（3 人決定性 fixture） ──────────────────────
  process.env.DUTY_MOCK = "1";
  __resetDutyCache();

  // 搵 staff 自己店 code（cookie = TKW staff）
  const staffRow = await prisma.staffUser.findFirst({ where: { email: { contains: "tkw" } }, select: { clinicId: true } });
  const staffClinicId = staffRow?.clinicId;
  const ownCode =
    (staffClinicId
      ? await prisma.clinic.findUnique({ where: { id: staffClinicId }, select: { code: true } })
      : null)?.code ?? "TKW";
  const otherCode = ownCode === "TKW" ? "MF" : "TKW";

  // (1) 自己店（唔帶 param = 自己店）
  const resOwn = await GET(mkReq("/api/duty-roster"), { params: Promise.resolve({}) });
  const bodyOwn = (await resOwn.json().catch(() => null)) as { duty?: { staffName: string }[] | null } | null;
  const ownOk = resOwn.status === 200 && Array.isArray(bodyOwn?.duty) && bodyOwn.duty.length === 3;
  console.log(`DUTY-HTTP=${resOwn.status} DUTY-COUNT=${Array.isArray(bodyOwn?.duty) ? bodyOwn.duty.length : 0}`);
  console.log(ownOk ? "DUTY-MOCK-OK" : `DUTY-MOCK-FAIL ${resOwn.status} ${JSON.stringify(bodyOwn)?.slice(0, 200)}`);
  if (!ownOk) fail = 1;

  // (2) 別店 param → 403（RBAC fail-closed）
  const resOther = await GET(mkReq(`/api/duty-roster?clinicId=${otherCode}`), { params: Promise.resolve({}) });
  if (resOther.status === 403) console.log("DUTY-403-OK");
  else {
    console.log(`DUTY-403-FAIL (expected 403, got ${resOther.status})`);
    fail = 1;
  }

  await prisma.$disconnect();
  process.exit(fail);
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});
