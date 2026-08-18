#!/usr/bin/env bash
#
# restore-wa-test.sh — restore 驗證（MD §9.3 backup 部分嘅驗收：restore 落 scratch DB + 抽 5 表 row count 對）。
#
# 行為：
# 1. 入參 = dump 檔（預設 = BACKUP_DIR 入面最新一個 wa-inbox-*.dump / .dump.age）
# 2. .age 檔 → age 解密（.dev/age.key）
# 3. 自動偵測 dump 格式：
#    • PGDMP（pg_dump -Fc 標準軌）→ pg_restore 落 scratch DB
#    • 其他（tar.gz CSV fallback 軌）→ 解壓 → prisma migrate deploy（重建 schema）
#      → 逐表 COPY CSV（先 DISABLE TRIGGER ALL 避 FK 順序問題）
# 4. ★ 一律 restore 落 scratch DB `wa_inbox_restore_test`（唔會郁生產 DB）
# 5. 抽 5 表（Message / Conversation / Contact / AiDraft / BookingRequest）row count 同源 DB 對
# 6. 全部對 → exit 0 + "RESTORE-TEST OK"；任何唔對 → exit 1
#
# 用法：bash scripts/restore-wa-test.sh [path-to-dump]
#
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then set -a; . ./.env; set +a; fi
BACKUP_DIR="${BACKUP_DIR:-.dev/backups}"
AGE_KEY_FILE="${AGE_KEY_FILE:-.dev/age.key}"
SCRATCH_DB="wa_inbox_restore_test"
TABLES=(Message Conversation Contact AiDraft BookingRequest)

# ── 解析 DATABASE_URL（同 backup-wa.sh 同一寫法） ────────────────────────
DB_URL="${DATABASE_URL:-postgresql://wa_inbox:wa_inbox_dev_pw_2026@127.0.0.1:15432/wa_inbox}"
if [ -n "${PGHOST:-}" ]; then
  _host="${PGHOST}"; _port="${PGPORT:-5432}"; _user="${PGUSER:-wa_inbox}"
  _pass="${PGPASSWORD:-}"; _dbname="${PGDATABASE:-wa_inbox}"
else
  _tmp="${DB_URL#*://}"
  _userpass="${_tmp%%@*}"
  _rest="${_tmp#*@}"
  _user="${_userpass%%:*}"
  if [[ "$_userpass" == *:* ]]; then _pass="${_userpass#*:}"; else _pass=""; fi
  _hostport="${_rest%%/*}"
  _dbname="${_rest#*/}"; _dbname="${_dbname%%\?*}"
  _host="${_hostport%%:*}"
  _port="${_hostport#*:}"; [ "$_port" = "$_hostport" ] && _port=5432
fi
export PGHOST="$_host" PGPORT="$_port" PGUSER="$_user" PGPASSWORD="$_pass"
SCRATCH_URL="postgresql://$_user:$_pass@$_host:$_port/$SCRATCH_DB"

# ── 搵 dump 檔 ─────────────────────────────────────────────────────────
DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DUMP=$(ls -1t "$BACKUP_DIR"/wa-inbox-*.dump.age "$BACKUP_DIR"/wa-inbox-*.dump 2>/dev/null | head -1)
fi
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "FATAL: 搵唔到 dump 檔（用法：$0 [path-to-dump]）"; exit 1; }
echo "[restore-test] dump: $DUMP"

# 清理 helper（★ 只可以删 temp 檔，永遠唔可以删原 dump）
cleanup() {
  [ "$RESTORE_SRC" != "$DUMP" ] && rm -f "$RESTORE_SRC"
  [ -n "${EXTRACT_DIR:-}" ] && rm -rf "$EXTRACT_DIR"
}
fail() { echo "FATAL: $1" >&2; cleanup; exit 1; }

# .age → 解密
RESTORE_SRC="$DUMP"
case "$DUMP" in
  *.age)
    command -v age >/dev/null 2>&1 || fail ".age 檔但 age 未安裝"
    [ -f "$AGE_KEY_FILE" ] || fail "冇 $AGE_KEY_FILE（解唔到）"
    RESTORE_SRC="$(mktemp /tmp/wa-restore-XXXXXX.dump)"
    if ! age -d -i "$AGE_KEY_FILE" -o "$RESTORE_SRC" "$DUMP" 2>/dev/null; then
      fail "age 解密失敗（key 錯？）"
    fi
    echo "[restore-test] age 解密 OK → $RESTORE_SRC"
    ;;
esac

# ── scratch DB ─────────────────────────────────────────────────────────
psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $SCRATCH_DB;" >/dev/null 2>&1
psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SCRATCH_DB;" >/dev/null 2>&1 || fail "create scratch db 失敗"
echo "[restore-test] scratch db: $SCRATCH_DB"

# ── 格式偵測 + restore ─────────────────────────────────────────────────
MAGIC=$(head -c 5 "$RESTORE_SRC" 2>/dev/null | tr -d '\0')
EXTRACT_DIR=""
case "$MAGIC" in
  PGDMP)
    echo "[restore-test] 格式: pg_dump custom (-Fc) → pg_restore"
    if ! pg_restore --dbname="$SCRATCH_DB" --no-owner "$RESTORE_SRC" 2>/tmp/wa-restore-restore.log; then
      echo "WARNING: pg_restore 有 warning（常見：owner/extension）— 見 /tmp/wa-restore-restore.log"
      # pg_restore 對 custom format 有時回非 0 但數據完整；以 row count 對數為準
    fi
    ;;
  *)
    echo "[restore-test] 格式: CSV fallback（tar.gz）→ migrate deploy + COPY"
    EXTRACT_DIR=$(mktemp -d /tmp/wa-restore-d-XXXXXX)
    if ! tar -xzf "$RESTORE_SRC" -C "$EXTRACT_DIR" 2>/tmp/wa-restore-tar.log; then
      fail "解壓失敗（唔係 tar.gz dump？）"
    fi
    STAGE_DIR="$(find "$EXTRACT_DIR" -maxdepth 1 -type d -name '.stage-*' | head -1)"
    [ -n "$STAGE_DIR" ] || fail "搵唔到 stage 目錄（metadata.txt）"
    # schema 重建（repo migrations）
    if ! DATABASE_URL="$SCRATCH_URL" pnpm exec prisma migrate deploy > /tmp/wa-restore-migrate.log 2>&1; then
      tail -5 /tmp/wa-restore-migrate.log >&2
      fail "migrate deploy 失敗（scratch）"
    fi
    # 逐表 COPY（FK 順序：先 DISABLE TRIGGER ALL）
    DISABLED=()
    while IFS= read -r T; do
      [ -n "$T" ] || continue
      psql -d "$SCRATCH_DB" -c "ALTER TABLE \"$T\" DISABLE TRIGGER ALL;" >/dev/null 2>&1 && DISABLED+=("$T")
    done < "$STAGE_DIR/tables.list"
    COPIED=0
    while IFS= read -r T; do
      [ -n "$T" ] || continue
      CSV="$STAGE_DIR/tables/$T.csv"
      [ -f "$CSV" ] || fail "缺 tables/$T.csv"
      if psql -d "$SCRATCH_DB" -c "COPY \"$T\" FROM STDIN WITH (FORMAT csv, HEADER true)" < "$CSV" >/dev/null 2>&1; then
        COPIED=$((COPIED + 1))
      else
        fail "COPY $T 失敗"
      fi
    done < "$STAGE_DIR/tables.list"
    for T in "${DISABLED[@]}"; do
      psql -d "$SCRATCH_DB" -c "ALTER TABLE \"$T\" ENABLE TRIGGER ALL;" >/dev/null 2>&1
    done
    echo "[restore-test] COPY 完成：$COPIED tables"
    ;;
esac

# ── 5 表 row count 對數 ─────────────────────────────────────────────────
FAIL=0
printf "[restore-test] %-18s %-10s %-10s %s\n" "TABLE" "SOURCE" "SCRATCH" "CHECK"
for t in "${TABLES[@]}"; do
  SRC_N=$(psql -d "$_dbname" -tAc "SELECT count(*) FROM \"$t\";" 2>/dev/null)
  DST_N=$(psql -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM \"$t\";" 2>/dev/null)
  if [ "$SRC_N" = "$DST_N" ] && [ -n "$SRC_N" ]; then
    printf "[restore-test] %-18s %-10s %-10s ✅\n" "$t" "$SRC_N" "$DST_N"
  else
    printf "[restore-test] %-18s %-10s %-10s ❌ MISMATCH\n" "$t" "${SRC_N:-?}" "${DST_N:-?}"
    FAIL=1
  fi
done

# 清理（scratch db + temp）
psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $SCRATCH_DB;" >/dev/null 2>&1
cleanup

if [ "$FAIL" = 0 ]; then
  echo "RESTORE-TEST OK: 5 表 row count 全對（$SCRATCH_DB 已清）"
  exit 0
else
  echo "RESTORE-TEST FAILED: 有表 row count 唔對" >&2
  exit 1
fi
