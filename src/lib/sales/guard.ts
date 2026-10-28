import { NextResponse } from "next/server";
import { canReplyUnderLock, conversationSalesLock } from "@/lib/sales/core";

/**
 * ★ cwi-sales-20261028：綁定／保護中病人嘅對話 — 只有負責銷售同被轉交嘅同事可以覆。
 * 其他人（包 ADMIN）→ 423 SALES_LOCKED；ADMIN／主管可以喺對話頂部「強制接手」。
 * 放喺 Send Lock（負責人）檢查之後：兩樣都過先可以發。
 */
export async function salesLockResponse(conversationId: string, staffId: string): Promise<NextResponse | null> {
  const lock = await conversationSalesLock(conversationId);
  if (canReplyUnderLock(lock, staffId)) return null;
  const names = [...new Set(lock.owners.map((o) => o.name))].join("／");
  return NextResponse.json(
    {
      error: "SALES_LOCKED",
      message: `${names} 負責呢個病人（銷售）— 要佢轉交先可以覆`,
      owners: lock.owners.map((o) => ({ staffId: o.staffId, name: o.name, state: o.state })),
    },
    { status: 423 }
  );
}
