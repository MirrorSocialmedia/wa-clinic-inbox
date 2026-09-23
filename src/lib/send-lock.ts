import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/rbac";
/** ★ cwi-final S3-3：Send Lock 單一來源 — 有負責人而唔係自己 → 423（ADMIN 都唔豁免；要發先撳〔接手〕） */
export function sendLockResponse(ctx: Pick<AuthContext, "staff">, conv: { assigneeId: string | null }): NextResponse | null {
  if (conv.assigneeId && conv.assigneeId !== ctx.staff.id) {
    return NextResponse.json({ error: "SEND_LOCKED", message: "此對話已有負責人 — 你只可發內部備註，或撳〔接手〕", assigneeId: conv.assigneeId }, { status: 423 });
  }
  return null;
}
