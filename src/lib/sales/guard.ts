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

/**
 * 指派守門（assign route + PATCH /api/conversations/[id] 共用）：鎖住嘅對話只可以派畀負責銷售或者被轉交嘅同事。
 * 放返隊列（null）照准 — 新訊息會自動派返負責銷售。其他人要經右欄「轉交」／「主管強制接手」（留紀錄）。
 */
export async function salesAssignBlocked(conversationId: string, toStaffId: string | null): Promise<NextResponse | null> {
  if (!toStaffId) return null;
  const lock = await conversationSalesLock(conversationId);
  if (canReplyUnderLock(lock, toStaffId)) return null;
  const names = [...new Set(lock.owners.map((o) => o.name))].join("／");
  return NextResponse.json(
    { error: "SALES_LOCKED", message: `${names} 負責呢個病人（銷售）— 請用右欄「轉交」或者「主管強制接手」` },
    { status: 423 }
  );
}
