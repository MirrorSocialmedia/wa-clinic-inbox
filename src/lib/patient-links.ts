import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getRedis } from "@/lib/queue";
import { publishConvEvent, convRef } from "@/lib/notify";
import { phoneHash } from "@/lib/phone-hash";
import type { Conversation } from "@prisma/client";

/**
 * ★ cwi-multi-patient-20261018（擁有人拍板）：一個電話連幾個病人檔。
 *
 * 一個 WhatsApp 號碼可能代本人、年老父母、細路仔聯絡 → Contact 掛多個 ContactPatientLink；
 * 對話嘅「目前處理中病人」仍然係 Conversation.pinnedPatientApricotId（病人記錄／代落單跟佢）。
 *
 * 加入來源（防 staff 手改 body 釘唔相干嘅病人）：
 *   LOOKUP     — 電話配對（patient-lookup）清單入面
 *   SEARCH     — 呢位 staff 15 分鐘內搜尋結果入面（server 端 Redis 記低搜到嘅 id — 唔信 client）
 *   IDENTIFIED — 電話判定只認到一個 → 系統自動加
 */

export const RELATIONS = ["SELF", "PARENT", "CHILD", "SPOUSE", "SIBLING", "OTHER"] as const;
export type Relation = (typeof RELATIONS)[number];
export const RELATION_LABEL: Record<Relation, string> = {
  SELF: "本人",
  PARENT: "父母",
  CHILD: "子女",
  SPOUSE: "配偶",
  SIBLING: "兄弟姊妹",
  OTHER: "其他",
};

export interface LinkInput {
  contactId: string;
  patientApricotId: string;
  patientCode: string | null;
  patientName: string | null;
  source: "IDENTIFIED" | "LOOKUP" | "SEARCH";
  relation?: Relation | null;
  staffId: string | null;
}

/** 加入（已有 → 只補編號／名，唔覆蓋人手設嘅關係）。 */
export async function upsertPatientLink(i: LinkInput) {
  return prisma.contactPatientLink.upsert({
    where: { contactId_patientApricotId: { contactId: i.contactId, patientApricotId: i.patientApricotId } },
    create: {
      contactId: i.contactId,
      patientApricotId: i.patientApricotId,
      patientCode: i.patientCode,
      patientName: i.patientName,
      relation: i.relation ?? null,
      source: i.source,
      createdByStaffId: i.staffId,
    },
    update: {
      ...(i.patientCode ? { patientCode: i.patientCode } : {}),
      ...(i.patientName ? { patientName: i.patientName } : {}),
      ...(i.relation ? { relation: i.relation } : {}),
    },
  });
}

export async function listPatientLinks(contactId: string) {
  return prisma.contactPatientLink.findMany({ where: { contactId }, orderBy: { createdAt: "asc" } });
}

// ── 搜尋結果白名單（server 端記低 — 加入時核對；唔信 client 傳嘅病人資料）────────────
const SEARCH_TTL_SEC = 15 * 60;
const searchKey = (staffId: string, contactId: string) => `plink:search:${staffId}:${contactId}`;

export interface SearchHit {
  patientApricotId: string;
  patientCode: string;
  patientName: string;
}

export async function rememberSearchHits(staffId: string, contactId: string, hits: SearchHit[]): Promise<void> {
  if (!hits.length) return;
  try {
    const k = searchKey(staffId, contactId);
    const r = getRedis();
    await r.hset(k, Object.fromEntries(hits.map((h) => [h.patientApricotId, JSON.stringify(h)])));
    await r.expire(k, SEARCH_TTL_SEC);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "patient-links: 記搜尋結果失敗（加入時會要求重搜）");
  }
}

export async function recallSearchHit(staffId: string, contactId: string, patientApricotId: string): Promise<SearchHit | null> {
  try {
    const raw = await getRedis().hget(searchKey(staffId, contactId), patientApricotId);
    return raw ? (JSON.parse(raw) as SearchHit) : null;
  } catch {
    return null;
  }
}

// ── 設為對話「目前病人」（= 釘住；病人記錄／代落單跟佢）— pin route 同 links route 共用 ──

export async function setConversationPatient(
  conv: Conversation,
  waId: string,
  patient: { patientApricotId: string; patientName: string | null },
  staffId: string
): Promise<void> {
  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      pinnedPatientApricotId: patient.patientApricotId,
      pinnedPatientName: patient.patientName,
      pinnedPhoneHash: phoneHash(waId),
    },
  });
  await prisma.auditLog
    .create({
      data: {
        staffId,
        action: "PATIENT_PIN",
        entity: "Conversation",
        entityId: conv.id,
        meta: { patientApricotId: patient.patientApricotId, clinicId: conv.clinicId },
      },
    })
    .catch(() => undefined);
  // ★ cwi-final S1-7：獨立事件 patient:pinned（client 只 patch pinnedPatientApricotId）
  await publishConvEvent(convRef(conv), "patient:pinned", {
    conversationId: conv.id,
    clinicId: conv.clinicId,
    pinnedPatientApricotId: patient.patientApricotId,
  });
}
