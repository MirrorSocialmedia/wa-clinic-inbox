import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import prisma from "@/lib/prisma";
import log from "@/lib/log";

/**
 * POST /api/push/prefs — client 設定面板同步 push 偏好落 DB（StaffUser.pushPrefs）。
 *
 * ★ F-2（cwi-notify-fix-20260907）：一動作一欄（角色分離）— 舊版盲寫整包係根因
 * （mutedClinics 同 adminMsgClinics 被寫成相同內容 → 靜音濾走全部收件人）：
 * - STAFF：body 只接受 `mutedClinics`（黑名單語義 —「靜音呢間店」）
 * - ADMIN：body 只接受 `adminMsgClinics`（白名單語義 —「接收呢間店嘅訊息通知」）
 * - 另一欄喺 payload 出現 → 忽略 + log warn（唔寫入 — 防再污染）
 * - urgent 永遠唔受 adminMsgClinics 限制（push.ts 急症安全網 — 照舊）
 *
 * ★ 生死格：server 推送以 DB 為準 — client 改動必須落 DB 先至生效；
 *   localStorage 只做即時 UI。desktop/sound 係 per-device 設定，唔入 DB。
 * 驗證：只收 string 陣列；clinic id 必係存在嘅 clinic id（防垃圾 data）。
 */
export const dynamic = "force-dynamic";

function cleanClinicIds(v: unknown): string[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 64);
}

export const POST = handle(async (req: NextRequest) => {
  const { staff, res } = await requireAuth(req);
  const cookie = res.headers.get("set-cookie") ?? "";

  const body = (await req.json().catch(() => null)) as { mutedClinics?: unknown; adminMsgClinics?: unknown } | null;

  // F-2 角色分離：呢個角色擁有邊個欄
  const isStaff = staff.role === "STAFF";
  const acceptedKey = isStaff ? "mutedClinics" : "adminMsgClinics";
  const foreignKey = isStaff ? "adminMsgClinics" : "mutedClinics";

  // 另一欄出現喺 payload → 忽略 + warn（舊 client / 手工調用防線 — 唔寫入）
  if (body && body[foreignKey] != null) {
    log.warn(
      { staffId: staff.id, role: staff.role, foreignField: foreignKey, count: Array.isArray(body[foreignKey]) ? body[foreignKey].length : "n/a" },
      "push/prefs: payload 帶咗唔屬於呢個角色嘅欄位 — 忽略（唔寫入）"
    );
  }

  const accepted = cleanClinicIds(body ? body[acceptedKey] : undefined);
  if (accepted === null) {
    return Response.json({ error: "bad shape" }, { status: 400, headers: { "Set-Cookie": cookie } });
  }

  // 只留真正存在嘅 clinic id（fail-open：clinic 查詢失敗 → 照存原值，唔擋 UI）
  let ids = accepted;
  if (ids.length > 0) {
    try {
      const existing = await prisma.clinic.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const valid = new Set(existing.map((c) => c.id));
      ids = ids.filter((x) => valid.has(x));
    } catch {
      /* fail-open — 用原值 */
    }
  }

  // F-2：只寫自己角色嘅欄（另一欄唔入 JSON — 舊污染值順帶清走）
  const prefs: object = isStaff ? { mutedClinics: ids } : { adminMsgClinics: ids };
  await prisma.staffUser.update({
    where: { id: staff.id },
    data: { pushPrefs: prefs },
  });
  return Response.json({ ok: true }, { status: 200, headers: { "Set-Cookie": cookie } });
});
