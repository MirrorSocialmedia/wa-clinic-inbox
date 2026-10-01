#!/usr/bin/env bash
set -e
# ★ cwi-qa CI-T1：src/**/*.test.ts（node:test）— 之前 CI 從未執行（只跑 scripts/unit-*.ts）。
#   獨立 DB wa_t + Redis db 5，唔污染後面 mock-e2e；測試 helper 讀 repo 根 .env → 臨時寫、跑完即刪。
#   逐個檔直接 `tsx <file>`（唔用 `--test <path>`：路徑含 [id]/[file] 會被當 glob → 0 個測試假綠）。
#   ★ cwi-qa CI-T1b：`db:seed` 會為「DB 未有嘅帳號」重新產生隨機密碼並覆寫 .dev/credentials.txt —
#     wa_t 係全新 DB → 全部帳號新密碼 → 後面 mock-e2e 用 wa_t 密碼登入主 DB wa → 全部 401
#     （2026-10-01 CI run #29–#34 實錚，本地重現：T1 login staff-tkw → 401）。
#     → .env 同 .dev/credentials.txt 跑前備份、EXIT（包括失敗）一律還原，最後 cmp 自檢冇改動。
CRED_SHA_BEFORE=$(sha256sum .dev/credentials.txt 2>/dev/null | cut -d" " -f1 || true)
SNAP=$(mktemp -d)
for f in .env .dev/credentials.txt; do
  if [ -f "$f" ]; then mkdir -p "$SNAP/$(dirname "$f")"; cp -p "$f" "$SNAP/$f"; fi
done
restore() {
  for f in .env .dev/credentials.txt; do
    if [ -f "$SNAP/$f" ]; then cp -p "$SNAP/$f" "$f"; else rm -f "$f"; fi
  done
  rm -rf "$SNAP"
}
trap restore EXIT
PGPASSWORD=pw psql -h localhost -p 15432 -U postgres -qc "DROP DATABASE IF EXISTS wa_t" -c "CREATE DATABASE wa_t"
T_DB="postgresql://postgres:pw@localhost:15432/wa_t?connection_limit=15&pool_timeout=10"
cat > .env <<ENV
DATABASE_URL="$T_DB"
REDIS_URL=redis://localhost:6379/5
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
TOTP_ENC_KEY=$(openssl rand -base64 32)
MEDIA_ENC_KEY=$(openssl rand -hex 32)
PHONE_HASH_KEY=$(openssl rand -hex 32)
FLOW_JWT_SECRET=$(openssl rand -hex 32)
INTERNAL_LLM_SECRET=$(openssl rand -hex 32)
WA_APP_SECRET=ci-test-app-secret
WA_VERIFY_TOKEN=ci-test-verify
APP_HOST=127.0.0.1:3100
ENV
set -a; . ./.env; set +a
pnpm -s migrate:deploy && pnpm -s db:seed && pnpm -s tsx scripts/seed-knowledge.ts && pnpm -s tsx scripts/seed-followup-p4.ts
n=0
while IFS= read -r f; do
  n=$((n+1)); echo "--- $f"
  if out=$(timeout 180 pnpm -s tsx "$f" 2>&1); then rc=0; else rc=$?; fi
  printf '%s\n' "$out" | grep -E "^(not ok|# (pass|fail))" || true
  if [ "$rc" != 0 ]; then printf '%s\n' "$out" | tail -40; echo "SRC-TEST-FAIL $f (rc=$rc)"; exit 1; fi
done < <(find src -name '*.test.ts' | sort)
[ "$n" -gt 0 ] || { echo "冇搵到 src/**/*.test.ts"; exit 1; }
restore; trap - EXIT
# 自檢：主環境檔案冇被改（防將來有人再加會寫檔嘅 seed／測試）
CRED_SHA_AFTER=$(sha256sum .dev/credentials.txt 2>/dev/null | cut -d" " -f1 || true)
if [ "$CRED_SHA_BEFORE" != "$CRED_SHA_AFTER" ]; then
  echo "FATAL: .dev/credentials.txt 喺 src tests 前後唔一樣（before=${CRED_SHA_BEFORE:-無} after=${CRED_SHA_AFTER:-無}）"; exit 1
fi
echo "src tests: $n files OK"
