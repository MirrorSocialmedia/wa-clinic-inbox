#!/usr/bin/env bash
# ★ cwi-final S0-10：部署前檢查 — 任何 ✗ 都唔准 build／restart
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0; warn=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fail=1; }
wrn() { echo "  ⚠ $1"; warn=1; }
# ★ cwi-final F-8：去行尾註釋 + 去前後空白 + 去引號（.env 好多行係 `KEY=value   # 註釋`）
envv() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" .env | tail -1 \
    | sed -E "s/^[[:space:]]*(export[[:space:]]+)?$1=//; s/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^[\"']//; s/[\"']$//"
}

echo "== .env =="
[ "$(envv RETENTION_CONV_MONTHS)" = "24" ] && ok "RETENTION_CONV_MONTHS=24" || bad "RETENTION_CONV_MONTHS 必須 = 24（政策）"
[ "$(envv RETENTION_MEDIA_MONTHS)" = "12" ] && ok "RETENTION_MEDIA_MONTHS=12" || bad "RETENTION_MEDIA_MONTHS 必須 = 12（政策）"
# APP_HOST 喺 S3-6 上線之後先加入呢個 list
for k in MEDIA_ENC_KEY PHONE_HASH_KEY WA_APP_SECRET SESSION_SECRET TOTP_ENC_KEY FLOW_JWT_SECRET; do
  v="$(envv $k)"; [ -n "$v" ] && ok "$k 有值" || bad "$k 未設"
done
for k in MEDIA_ENC_KEY PHONE_HASH_KEY SESSION_SECRET; do
  v="$(envv $k)"; [ "${#v}" -ge 32 ] || bad "$k 長度 < 32"
done
if [ "$(envv ALLOW_MOCK_IN_PROD)" != "1" ]; then
  for k in AI_MOCK WA_MOCK DUTY_MOCK WORKFORCE_MOCK AI_MOCK_FAIL WA_GRAPH_MOCK_FAIL; do
    [ "$(envv $k)" = "1" ] && bad "$k=1（production 唔准開 mock）"
  done
  ok "mock flags 已檢查"
fi
[ "$(envv REMINDER_AUTO_SEND)" = "1" ] && wrn "REMINDER_AUTO_SEND=1 — A4 拍板咗未？（S0-8）"
[ "$(envv ALLOW_SLOT_CLAIM)" = "1" ] && { [ -f docs/fixplan/G2-signed-off ] && ok "ALLOW_SLOT_CLAIM=1（G2 已簽）" || bad "ALLOW_SLOT_CLAIM=1 但 G2 未簽（Stage 5 驗收完先開）"; }
[ "$(envv ALLOW_SCOPED_ADMIN)" = "1" ] && { [ -f docs/fixplan/G3-signed-off ] || bad "ALLOW_SCOPED_ADMIN=1 但 S3-1 未簽"; }

echo "== Redis =="
RU="$(envv REDIS_URL)"
[ "$(redis-cli -u "$RU" CONFIG GET appendonly | tail -1)" = "yes" ] && ok "appendonly yes" || bad "Redis appendonly 唔係 yes"
[ "$(redis-cli -u "$RU" CONFIG GET maxmemory-policy | tail -1)" = "noeviction" ] && ok "noeviction" || bad "Redis maxmemory-policy 唔係 noeviction"

echo "== DB =="
pnpm -s tsx scripts/predeploy-db-check.ts || fail=1

echo "== 備份 =="
BD="$(envv BACKUP_DIR)"; BD="${BD:-.dev/backups}"
f="$(ls -t "$BD"/wa-inbox-*.dump* 2>/dev/null | head -1)"
if [ -n "$f" ] && [ $(( $(date +%s) - $(stat -c %Y "$f") )) -lt 93600 ]; then ok "最近備份 < 26h"; else bad "最近備份 > 26 小時或者冇"; fi

[ $fail -eq 0 ] && echo "PREDEPLOY OK（warn=$warn）" || { echo "PREDEPLOY FAILED"; exit 1; }
