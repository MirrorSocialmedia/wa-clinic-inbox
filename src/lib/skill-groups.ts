/**
 * ★ cwi-auditfix-20260908（B-1 防止進入壞狀態）：技能組寫入不變量。
 *
 * 不變量：**組嘅每個成員必須綁定該組服務嘅每一間店**（StaffClinic 行存在）。
 * 違反 = 被 route 嘅對話對該成員「鎖死」（收得 push、開唔到、邊個列表都唔見 — 審計 B-1）。
 *
 * 適用寫入路徑（全走 replace 語義 — 最終狀態驗證即覆蓋「加成員」∨「加新服務店」）：
 * - POST /api/admin/skill-groups（建組帶 memberIds + clinicIds）
 * - PATCH /api/admin/skill-groups/[id]（memberIds / clinicIds 全量 replace）
 *
 * 失敗 → 400「{staff 名} 未綁定 {店}，請先去員工帳號加店」。
 * 既有（seed/UI 歷史）壞狀態唔回掃 — 由 assertConversationAccess 第四條放行兜底。
 */
type Tx = PrismaClientLike;

/** 結構性最小介面 — prisma client 同 $transaction callback 嘅 tx 都符合。 */
interface PrismaClientLike {
  staffClinic: {
    findMany(args: { where: { staffId: { in: string[] }; clinicId: { in: string[] } }; select: { staffId: true; clinicId: true } }): Promise<{ staffId: string; clinicId: string }[]>;
  };
  staffUser: {
    findUnique(args: { where: { id: string }; select: { name: true } }): Promise<{ name: string } | null>;
  };
  clinic: {
    findUnique(args: { where: { id: string }; select: { name: true; code: true } }): Promise<{ name: string; code: string } | null>;
  };
}

/**
 * 驗證 members × clinics 全部有 StaffClinic 綁定。
 * @returns null = 通過；string = 第一條違規嘅 400 訊息（zero PII — staff/clinic 名係 staff 管理數據）。
 */
export async function assertGroupMembersBound(
  tx: Tx,
  memberIds: string[],
  clinicIds: string[]
): Promise<string | null> {
  if (memberIds.length === 0 || clinicIds.length === 0) return null;
  const uniqueMembers = [...new Set(memberIds)];
  const uniqueClinics = [...new Set(clinicIds)];
  const bindings = await tx.staffClinic.findMany({
    where: { staffId: { in: uniqueMembers }, clinicId: { in: uniqueClinics } },
    select: { staffId: true, clinicId: true },
  });
  const bound = new Set(bindings.map((b) => `${b.staffId}|${b.clinicId}`));
  for (const staffId of uniqueMembers) {
    for (const clinicId of uniqueClinics) {
      if (bound.has(`${staffId}|${clinicId}`)) continue;
      const [staff, clinic] = await Promise.all([
        tx.staffUser.findUnique({ where: { id: staffId }, select: { name: true } }),
        tx.clinic.findUnique({ where: { id: clinicId }, select: { name: true, code: true } }),
      ]);
      const who = staff?.name ?? staffId;
      const what = clinic ? `${clinic.name}（${clinic.code}）` : clinicId;
      return `${who} 未綁定 ${what}，請先去員工帳號加店`;
    }
  }
  return null;
}
