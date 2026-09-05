import { type NextRequest } from "next/server";
import { handle } from "@/lib/api-error";
import { requireAuth } from "@/lib/rbac";
import prisma from "@/lib/prisma";

/**
 * POST /api/push/prefs — client 設定面板同步 push 偏好落 DB（StaffUser.pushPrefs）。
 * body: { mutedClinics?: string[], adminMsgClinics?: string[] }
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
  const mutedClinics = cleanClinicIds(body?.mutedClinics);
  const adminMsgClinics = cleanClinicIds(body?.adminMsgClinics);
  if (mutedClinics === null || adminMsgClinics === null) {
    return Response.json({ error: "bad shape" }, { status: 400, headers: { "Set-Cookie": cookie } });
  }

  // 只留真正存在嘅 clinic id（fail-open：clinic 查詢失敗 → 照存原值，唔擋 UI）
  let prefs: { mutedClinics: string[]; adminMsgClinics: string[] } = { mutedClinics, adminMsgClinics };
  const all = [...new Set([...mutedClinics, ...adminMsgClinics])];
  if (all.length > 0) {
    try {
      const existing = await prisma.clinic.findMany({ where: { id: { in: all } }, select: { id: true } });
      const valid = new Set(existing.map((c) => c.id));
      prefs = {
        mutedClinics: mutedClinics.filter((x) => valid.has(x)),
        adminMsgClinics: adminMsgClinics.filter((x) => valid.has(x)),
      };
    } catch {
      /* fail-open — 用原值 */
    }
  }

  await prisma.staffUser.update({
    where: { id: staff.id },
    data: { pushPrefs: prefs as object },
  });
  return Response.json({ ok: true }, { status: 200, headers: { "Set-Cookie": cookie } });
});
