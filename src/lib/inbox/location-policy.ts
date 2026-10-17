import prisma from "@/lib/prisma";

/**
 * ★ cwi-inbox-r4（擁有人拍板 2026-10-17）：轉地點可去邊 — 單一來源（GET 選項 + POST 檢查共用）。
 *
 * 規則：號碼店（Conversation.clinicId）所屬公司 = 「病人關係擁有者」：
 *   - 同公司任何分店 ✔
 *   - 號碼店公司嘅 transferToCompanyIds 白名單入面嘅公司 ✔（跨公司 — crossCompany=true）
 *   - 其他 ✖
 * 號碼店未分公司（companyId=null）→ 只限同樣未分公司嘅分店（舊行為）。
 */
export interface TransferOption {
  id: string;
  code: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  crossCompany: boolean;
}

export async function transferOptions(channelClinicId: string): Promise<TransferOption[]> {
  const channel = await prisma.clinic.findUnique({
    where: { id: channelClinicId },
    select: { companyId: true, company: { select: { transferToCompanyIds: true } } },
  });
  if (!channel) return [];
  const own = channel.companyId ?? null;
  const allowed = new Set<string | null>([own, ...(channel.company?.transferToCompanyIds ?? [])]);
  const clinics = await prisma.clinic.findMany({
    select: { id: true, code: true, name: true, companyId: true, company: { select: { name: true } } },
    orderBy: { code: "asc" },
  });
  return clinics
    .filter((c) => allowed.has(c.companyId ?? null))
    .map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      companyId: c.companyId ?? null,
      companyName: c.company?.name ?? null,
      crossCompany: (c.companyId ?? null) !== own,
    }));
}
