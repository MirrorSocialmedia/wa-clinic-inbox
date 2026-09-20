/**
 * ★ cwi-final S1-2：列表常量 — client / server 共用。
 * 獨立檔（唔可以放 conversation-list.ts）：client bundle 唔可以 import 有 prisma 嘅檔。
 */

/** 每頁 row 數（keyset 分頁） */
export const LIST_PAGE_SIZE = 200;
/** client 自動追頁上限（超過 = truncated → 階段 B server 端膠囊分頁） */
export const ACTIVE_HARD_CAP = 5000;
/** active 首頁夾嘅 RESOLVED 尾（「睇已解決」入口之前嘅預覽量） */
export const RESOLVED_TAIL = 100;
