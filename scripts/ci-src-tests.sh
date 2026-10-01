#!/usr/bin/env bash
set -e
# ★ cwi-qa CI-T1：src/**/*.test.ts（node:test）— 之前 CI 從未執行（只跑 scripts/unit-*.ts）。
#   獨立 DB wa_t + Redis db 5，唔污染後面 mock-e2e；測試 helper 讀 repo 根 .env → 臨時寫、跑完即刪。
#   逐個檔直接 `tsx <file>`（唔用 `--test <path>`：路徑含 [id]/[file] 會被當 glob → 0 個測試假綠）。
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
trap 'rm -f .env' EXIT
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
echo "src tests: $n files OK"
