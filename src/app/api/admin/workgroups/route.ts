/**
 * ★ cwi-workgroup-20261104：老闆管理工作群（集團管理員先得）。
 * GET  → { groups: [{ id, name, archived, members }], staff: [{ id, name, role }] }（唔回訊息內容）
 * POST { name, memberIds? } → 201 { id }
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { adminCreateGroup, adminListGroups, staffDirectory } from "@/lib/workgroups";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";

const createSchema = z.object({ name: z.string().max(200), memberIds: z.array(z.string().max(64)).max(1000).optional() }).strict();

export const GET = handle(async (req: NextRequest) => {
  await requireGlobalAdmin(req);
  const [groups, staff] = await Promise.all([adminListGroups(), staffDirectory()]);
  return NextResponse.json({ groups, staff });
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireGlobalAdmin(req);
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "資料唔啱" }, { status: 400 });
  try {
    const id = await adminCreateGroup(ctx.staff.id, parsed.data);
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return wgError(e);
  }
});
