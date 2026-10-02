/**
 * ★ cwi-notify-a2/a3（2026-10-02）unit：Web Push 送出參數 + ADMIN「收全部店新訊息」預設。
 *
 * - a2 pushSendOptions：urgency=high（Doze／省電即刻喚醒）、TTL=24h（舊 60s 延遲派送就過期丟棄）、
 *   message 有 topic（同對話未派推送被取代；22 字 URL-safe base64、唔洩露 conversationId）、urgent／notice 冇 topic
 * - a3 effectiveAdminMsgAll／parsePushPrefs：ADMIN 未設 = true、false = 白名單、SUPERVISOR 永遠 false
 * - a3 shouldNotify（client）：ADMIN 預設收 message；adminMsgAll=false → 白名單；urgent 永遠收
 *
 * 純函數 — 唔使 DB／Redis。運行：pnpm tsx scripts/unit-notify-a.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pushSendOptions, PUSH_TTL_SEC, effectiveAdminMsgAll, parsePushPrefs } from "../src/lib/push";
import { shouldNotify, type ShouldNotifyArgs } from "../src/lib/notify-client";
import { closeRedis } from "../src/lib/queue";
import prisma from "../src/lib/prisma";

// push.ts import 鏈（@/lib/notify → queue）會開 Redis／Prisma client — 收尾關晒，否則 process 唔退出
after(async () => {
  await closeRedis().catch(() => {});
  await prisma.$disconnect().catch(() => {});
});

test("a2: message → urgency high + TTL 24h + topic（22 字 URL-safe、穩定、唔含 id）", () => {
  const o = pushSendOptions({ kind: "message", conversationId: "cmconv1234567890abcdef" });
  assert.equal(o.urgency, "high");
  assert.equal(o.TTL, 86400);
  assert.equal(PUSH_TTL_SEC, 86400);
  assert.match(String(o.topic), /^[A-Za-z0-9_-]{22}$/);
  assert.equal(o.topic, pushSendOptions({ kind: "message", conversationId: "cmconv1234567890abcdef" }).topic, "同對話 topic 穩定");
  assert.notEqual(o.topic, pushSendOptions({ kind: "message", conversationId: "cmconvOTHER" }).topic, "唔同對話唔同 topic");
  assert.ok(!String(o.topic).includes("cmconv"), "topic 唔洩露 conversationId");
  assert.equal(o.timeout, 8000);
});

test("a2: urgent／notice／冇 conversationId → 冇 topic（唔可以被普通訊息蓋走）但照 high + 24h", () => {
  for (const p of [
    { kind: "urgent" as const, conversationId: "c1" },
    { kind: "notice" as const, conversationId: "c1" },
    { kind: "message" as const, conversationId: "" },
  ]) {
    const o = pushSendOptions(p);
    assert.equal(o.topic, undefined, JSON.stringify(p));
    assert.equal(o.urgency, "high");
    assert.equal(o.TTL, 86400);
  }
});

test("a3: parsePushPrefs 讀 adminMsgAll（boolean 先算；其他 = null）", () => {
  assert.equal(parsePushPrefs(null).adminMsgAll, null);
  assert.equal(parsePushPrefs({ adminMsgClinics: ["x"] }).adminMsgAll, null);
  assert.equal(parsePushPrefs({ adminMsgAll: false }).adminMsgAll, false);
  assert.equal(parsePushPrefs({ adminMsgAll: true }).adminMsgAll, true);
  assert.equal(parsePushPrefs({ adminMsgAll: "false" }).adminMsgAll, null);
});

test("a3: effectiveAdminMsgAll — ADMIN 未設 = true；false = false；SUPERVISOR／STAFF 永遠 false", () => {
  assert.equal(effectiveAdminMsgAll("ADMIN", { adminMsgAll: null }), true);
  assert.equal(effectiveAdminMsgAll("ADMIN", { adminMsgAll: true }), true);
  assert.equal(effectiveAdminMsgAll("ADMIN", { adminMsgAll: false }), false);
  assert.equal(effectiveAdminMsgAll("SUPERVISOR", { adminMsgAll: null }), false);
  assert.equal(effectiveAdminMsgAll("SUPERVISOR", { adminMsgAll: true }), false);
  assert.equal(effectiveAdminMsgAll("STAFF", { adminMsgAll: true }), false);
});

const base: ShouldNotifyArgs = {
  kind: "message",
  clinicId: "TKW",
  conversationId: "c1",
  assigneeId: null,
  myStaffId: "me",
  myRole: "ADMIN",
  activeConversationId: null,
  mutedClinics: [],
  adminMsgClinics: [],
};

test("a3: shouldNotify ADMIN — 預設（adminMsgAll 未傳）收 message／notice", () => {
  assert.equal(shouldNotify(base), true);
  assert.equal(shouldNotify({ ...base, kind: "notice" }), true);
  assert.equal(shouldNotify({ ...base, adminMsgAll: true }), true);
});

test("a3: shouldNotify ADMIN — adminMsgAll=false → 白名單；urgent 永遠收；開住嘅對話照靜（N-5）", () => {
  assert.equal(shouldNotify({ ...base, adminMsgAll: false }), false);
  assert.equal(shouldNotify({ ...base, adminMsgAll: false, adminMsgClinics: ["TKW"] }), true);
  assert.equal(shouldNotify({ ...base, adminMsgAll: false, kind: "urgent" }), true);
  assert.equal(shouldNotify({ ...base, activeConversationId: "c1" }), false);
});

test("a3: shouldNotify STAFF 規則不變（adminMsgAll 唔影響 STAFF）", () => {
  const staff = { ...base, myRole: "STAFF" as const, adminMsgAll: true };
  assert.equal(shouldNotify({ ...staff, assigneeId: null }), true);
  assert.equal(shouldNotify({ ...staff, assigneeId: "other" }), false);
  assert.equal(shouldNotify({ ...staff, assigneeId: "me" }), true);
});
