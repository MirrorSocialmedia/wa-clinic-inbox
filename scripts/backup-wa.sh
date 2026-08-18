#!/usr/bin/env bash
#
# backup-wa.sh — WA Clinic Inbox 全量 backup（MD §9.3）。
#
# 1. pg_dump wa_inbox（custom format -Fc，俾 pg_restore 选择性還原）
#    • 來源：$DATABASE_URL（.env 或 env）；預設 = embedded postgres 127.0.0.1:15432
#    • ★ version mismatch fallback：pg_dump client 比 server 舊（sandbox：pg_dump 16 vs
#      embedded PG 18）→ CSV logical dump（tables/*.csv + metadata）落同一個 .dump 檔
#      （tar.gz）。data-only（schema 由 migrate 重建）— 只係 sandbox/E2E 軌；
#      生產 VPS 裝返同 server 版本嘅 postgresql-client 就返標準軌。
# 2. 加密（兩軌）：
#    • 有 `age`：age 加密（keypair .dev/age.key，gitignored；首次自動生成 + 響亮提示要備份 pubkey）
#    • 冇 `age`（sandbox 預設）：明文 + 響亮 WARNING（script 唔 fail — 本地開發可接受；
#      上線 VPS 必須裝 age，明文檔 30 日 retention 內唔好出機）
# 3. retention：dump 檔 30 日（舊檔清）
# 4. media：$WA_MEDIA_DIR（預設 /srv/wa-media）→ snapshot 落 backup dir，同 30 日 retention
#
# 用法：bash scripts/backup-wa.sh
# 排程：VPS crontab 每晚一次（例：`30 2 * * * cd /srv/wa-clinic-inbox && bash scripts/backup-wa.sh >> /var/log/wa-backup.log 2>&1`）
#
set -uo pipefail
cd "$(dirname "$0")/.."

# ── env ──────────────────────────────────────────────────────────────────
if [ -f .env ]; then set -a; . ./.env; set +a; fi
BACKUP_DIR="${BACKUP_DIR:-.dev/backups}"
MEDIA_DIR="${WA_MEDIA_DIR:-/srv/wa-media}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
AGE_KEY_FILE="${AGE_KEY_FILE:-.dev/age.key}"
STAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR" "$BACKUP_DIR/media"

# ── 解析 DATABASE_URL → pg 連線參數 ─────────────────────────────────────
DB_URL="${DATABASE_URL:-postgresql://wa_inbox:wa_inbox_dev_pw_2026@127.0.0.1:15432/wa_inbox}"
# postgresql://user:pass@host:port/db（密碼含特殊字符時請改 URL-encode；
# 或用 PG* env：PGHOST/PGPORT/PGUSER/PGPASSWORD 直接覆蓋）
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
echo "[backup] target db: $_user@$_host:$_port/$_dbname → $BACKUP_DIR (retention ${RETENTION_DAYS}d)"

# ── 1. dump（標準 pg_dump -Fc；version mismatch → CSV fallback） ─────────
DUMP_RAW="$BACKUP_DIR/wa-inbox-$STAMP.dump"
pg_dump -Fc -f "$DUMP_RAW" "$_dbname" 2>/tmp/wa-backup-pgdump.log
DUMP_RC=$?
if [ "$DUMP_RC" = 0 ]; then
  echo "[backup] pg_dump OK: $DUMP_RAW ($(du -h "$DUMP_RAW" | cut -f1))"
else
  if grep -q "server version mismatch" /tmp/wa-backup-pgdump.log 2>/dev/null; then
    echo "WARNING: pg_dump version mismatch（$(pg_dump --version | awk '{print $3}') client vs $(psql -d "$_dbname" -tAc 'SHOW server_version;' 2>/dev/null || echo '?') server）" >&2
    echo "WARNING: fallback → CSV logical dump（data-only；sandbox/E2E 軌 — 生產請裝同版本 postgresql-client）" >&2
    STAGE="$BACKUP_DIR/.stage-$STAMP"
    mkdir -p "$STAGE/tables"
    psql -d "$_dbname" -tAc "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name" > "$STAGE/tables.list" || { echo "FATAL: 讀 table 列表失敗" >&2; rm -rf "$STAGE"; exit 1; }
    while IFS= read -r T; do
      [ -n "$T" ] || continue
      if ! psql -d "$_dbname" -c "COPY \"$T\" TO STDOUT WITH (FORMAT csv, HEADER true)" > "$STAGE/tables/$T.csv" 2>/tmp/wa-backup-copy.log; then
        echo "FATAL: COPY $T 失敗" >&2; cat /tmp/wa-backup-copy.log >&2; rm -rf "$STAGE"; exit 1
      fi
    done < "$STAGE/tables.list"
    {
      echo "format=csv-fallback"
      echo "db=$_dbname"
      echo "pg_server=$(psql -d "$_dbname" -tAc 'SHOW server_version;' 2>/dev/null)"
      echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$STAGE/metadata.txt"
    NTAB=$(grep -c . "$STAGE/tables.list" 2>/dev/null || echo 0)
    tar -czf "$DUMP_RAW" -C "$BACKUP_DIR" ".stage-$STAMP"
    rm -rf "$STAGE"
    echo "[backup] CSV fallback dump OK: $DUMP_RAW ($(du -h "$DUMP_RAW" | cut -f1), $NTAB tables)"
  else
    echo "FATAL: pg_dump failed" >&2
    tail -5 /tmp/wa-backup-pgdump.log >&2
    rm -f "$DUMP_RAW"
    exit 1
  fi
fi

# ── 2. 加密（age 有/無兩軌） ────────────────────────────────────────────
if command -v age >/dev/null 2>&1; then
  if [ ! -f "$AGE_KEY_FILE" ]; then
    mkdir -p .dev
    age-keygen -o "$AGE_KEY_FILE" >/dev/null 2>&1
    chmod 600 "$AGE_KEY_FILE"
    echo "WARNING: 首次生成 age keypair（$AGE_KEY_FILE）— 請即刻另行備份 .dev/age.key，丟咗就解唔到！" >&2
  fi
  PUBKEY=$(age-keygen -y "$AGE_KEY_FILE" 2>/dev/null | head -1 | sed 's/^public key: //')
  DUMP_ENC="$BACKUP_DIR/wa-inbox-$STAMP.dump.age"
  if age -r "$PUBKEY" -o "$DUMP_ENC" "$DUMP_RAW"; then
    rm -f "$DUMP_RAW"
    echo "[backup] age 加密 OK: $DUMP_ENC (pubkey=${PUBKEY:0:16}…)"
  else
    echo "FATAL: age 加密失敗 — 保留明文檔，請手動處理" >&2
    exit 1
  fi
else
  echo "WARNING: age 未安裝 — backup 以【明文】儲存（sandbox 預設軌；上線前必須裝 age）" >&2
  echo "WARNING: plaintext backup at $DUMP_RAW — 唔好出機 / 唔好入任何外置 disk" >&2
fi

# ── 3. media snapshot（/srv/wa-media 或 WA_MEDIA_DIR） ──────────────────
if [ -d "$MEDIA_DIR" ] && [ -n "$(ls -A "$MEDIA_DIR" 2>/dev/null)" ]; then
  MEDIA_SNAP="$BACKUP_DIR/media/wa-media-$STAMP"
  mkdir -p "$MEDIA_SNAP"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$MEDIA_DIR/" "$MEDIA_SNAP/" || echo "WARNING: media rsync 有 error（續行）" >&2
  else
    cp -a "$MEDIA_DIR/." "$MEDIA_SNAP/" || echo "WARNING: media cp 有 error（續行）" >&2
  fi
  echo "[backup] media snapshot OK: $MEDIA_SNAP ($(du -sh "$MEDIA_SNAP" | cut -f1))"
else
  echo "[backup] media dir 唔存在或空（$MEDIA_DIR）— skip media snapshot"
fi

# ── 4. retention（dump + media 各清 30 日前） ───────────────────────────
PRUNED=$(find "$BACKUP_DIR" -maxdepth 1 -name "wa-inbox-*.dump*" -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
PRUNED_M=$(find "$BACKUP_DIR/media" -maxdepth 1 -name "wa-media-*" -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
echo "[backup] retention: pruned $PRUNED dump(s), $PRUNED_M media snapshot(s) older than ${RETENTION_DAYS}d"
echo "[backup] DONE"
