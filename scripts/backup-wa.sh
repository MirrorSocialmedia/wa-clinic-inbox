#!/usr/bin/env bash
#
# backup-wa.sh — WA Clinic Inbox 全量 backup（MD §9.3 + 安全審計 C-2）。
#
# 1. pg_dump wa_inbox（custom format -Fc，俾 pg_restore 选择性還原）
#    • 來源：$DATABASE_URL（.env 或 env）；預設 = embedded postgres 127.0.0.1:15432
#    • ★ version mismatch fallback：pg_dump client 比 server 舊（sandbox：pg_dump 16 vs
#      embedded PG 18）→ CSV logical dump（tables/*.csv + metadata）落同一個 .dump 檔
#      （tar.gz）。data-only（schema 由 migrate 重建）— 只係 sandbox/E2E 軌；
#      生產 VPS 裝返同 server 版本嘅 postgresql-client 就返標準軌。
# 2. 加密（兩軌，安全審計 C-2 硬化）：
#    • ★ production（NODE_ENV 未設 = production）：age 必需 — 未裝 = FATAL exit 1
#      （明文 backup 唔准喺 production 靜默出產）
#    • dev（顯式 NODE_ENV=development）+ 冇 age：明文 + 響亮 WARNING（本地開發可接受）
#    • 有 age：dump + media snapshot 全部 age 加密（同一把 keypair）
# 3. retention：dump 檔 30 日（舊檔清）
# 4. media：$WA_MEDIA_DIR（預設 /srv/wa-media）→ snapshot 落 backup dir，同 30 日 retention；
#    有 age 時 media 一樣入加密軌（病人相 = 醫療資料，明文 snapshot 唔准出產）
# 5. 失敗警報（安全審計 C-2）：任何失敗 → 寫 flag 檔（$BACKUP_DIR 同層 backup-failed.flag，
#    內容只係 metadata：ts/reason/node_env — 零 log 原文）→ App 5 分鐘 health-check
#    見到 flag → 開 Alert(type=backup_failed, HIGH) + notifyAlert（走現有 alert 系統，冪等）；
#    下次成功 backup 清 flag → alert auto-resolve。
#
# age key runbook（★ 丟咗 = 所有加密 backup 永久解唔到）：
#    • dev：.dev/age.key（gitignored）— 首次跑自動 age-keygen，要人手離機備份
#      （password manager / 另一台機 — 唔好只留喺呢部機）
#    • production：age key 應喺 /etc/wa-inbox/age.key（0600，wa user 專屬），
#      用 AGE_KEY_FILE env 指過去；生成後即刻離機備份，唔好留 VPS 入面唯一一份
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
# 失敗 flag（App health-check 讀）— WA_BACKUP_FAIL_FLAG 可覆蓋（E2E 用）
FAIL_FLAG="${WA_BACKUP_FAIL_FLAG:-$(dirname "$BACKUP_DIR")/backup-failed.flag}"

# 失敗時寫 flag（App 端轉 Alert）— 寫唔到只係 warning（backup 本身已失敗，唔疊第二個錯）
mark_failed() {
  {
    echo "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "reason=$1"
    echo "node_env=${NODE_ENV:-production}"
  } > "$FAIL_FLAG" 2>/dev/null || echo "WARNING: 寫唔到 fail flag：$FAIL_FLAG" >&2
}

mkdir -p -m 700 "$BACKUP_DIR" "$BACKUP_DIR/media"
# 已存在嘅目錄唔受 mkdir -m 影響 → 顯式收緊（700 = 病人資料 backup 唔准 group/other 讀）
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

# ── C-2 fail-fast：production backup 必須 age 加密 ─────────────────────────
# NODE_ENV 未設 = production（VPS 實況）。local sandbox 要跑明文軌要顯式 NODE_ENV=development。
if [ "${NODE_ENV:-production}" = "production" ] && ! command -v age >/dev/null 2>&1; then
  echo "FATAL: production backup 必須 age 加密 — age 未安裝（上線前安裝 age，或本地 sandbox 顯式設 NODE_ENV=development）" >&2
  mark_failed "age_not_installed_production"
  exit 1
fi

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
    psql -d "$_dbname" -tAc "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name" > "$STAGE/tables.list" || { echo "FATAL: 讀 table 列表失敗" >&2; rm -rf "$STAGE"; mark_failed "pg_table_list_failed"; exit 1; }
    while IFS= read -r T; do
      [ -n "$T" ] || continue
      if ! psql -d "$_dbname" -c "COPY \"$T\" TO STDOUT WITH (FORMAT csv, HEADER true)" > "$STAGE/tables/$T.csv" 2>/tmp/wa-backup-copy.log; then
        echo "FATAL: COPY $T 失敗" >&2; cat /tmp/wa-backup-copy.log >&2; rm -rf "$STAGE"; mark_failed "pg_copy_failed"; exit 1
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
    mark_failed "pg_dump_failed"
    exit 1
  fi
fi

# ── 2. 加密（age 有/無兩軌；pubkey 只生成一次，dump + media 共用） ───────
AGE_PUBKEY=""
if command -v age >/dev/null 2>&1; then
  if [ ! -f "$AGE_KEY_FILE" ]; then
    mkdir -p .dev
    age-keygen -o "$AGE_KEY_FILE" >/dev/null 2>&1
    chmod 600 "$AGE_KEY_FILE"
    echo "WARNING: 首次生成 age keypair（$AGE_KEY_FILE）— 請即刻離機備份 $AGE_KEY_FILE，丟咗就全部 backup 解唔到！" >&2
  fi
  AGE_PUBKEY=$(age-keygen -y "$AGE_KEY_FILE" 2>/dev/null | head -1 | sed 's/^public key: //')
fi

if [ -n "$AGE_PUBKEY" ]; then
  DUMP_ENC="$BACKUP_DIR/wa-inbox-$STAMP.dump.age"
  if age -r "$AGE_PUBKEY" -o "$DUMP_ENC" "$DUMP_RAW"; then
    rm -f "$DUMP_RAW"
    echo "[backup] age 加密 OK: $DUMP_ENC (pubkey=${AGE_PUBKEY:0:16}…)"
  else
    echo "FATAL: age 加密失敗 — 保留明文檔，請手動處理" >&2
    mark_failed "age_encrypt_failed"
    exit 1
  fi
else
  echo "WARNING: age 未安裝（NODE_ENV=${NODE_ENV:-production}）— backup 以【明文】儲存（只限本地 sandbox 開發軌；production 應喺入面 FATAL）" >&2
  echo "WARNING: plaintext backup at $DUMP_RAW — 唔好出機 / 唔好入任何外置 disk" >&2
fi

# ── 3. media snapshot（/srv/wa-media 或 WA_MEDIA_DIR；有 age → 入加密軌） ──
if [ -d "$MEDIA_DIR" ] && [ -n "$(ls -A "$MEDIA_DIR" 2>/dev/null)" ]; then
  MEDIA_SNAP="$BACKUP_DIR/media/wa-media-$STAMP"
  mkdir -p "$MEDIA_SNAP"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$MEDIA_DIR/" "$MEDIA_SNAP/" || echo "WARNING: media rsync 有 error（續行）" >&2
  else
    cp -a "$MEDIA_DIR/." "$MEDIA_SNAP/" || echo "WARNING: media cp 有 error（續行）" >&2
  fi
  # ★ C-2：media = 病人相（醫療資料）— 有 age 時同樣 tar + age 加密，明文 snapshot 唔留碟
  if [ -n "$AGE_PUBKEY" ]; then
    MEDIA_TAR="$BACKUP_DIR/media/.wa-media-$STAMP.tar"
    MEDIA_ENC="$BACKUP_DIR/media/wa-media-$STAMP.age"
    if tar -cf "$MEDIA_TAR" -C "$MEDIA_SNAP" . && age -r "$AGE_PUBKEY" -o "$MEDIA_ENC" "$MEDIA_TAR"; then
      rm -rf "$MEDIA_SNAP" "$MEDIA_TAR"
      echo "[backup] media snapshot age 加密 OK: $MEDIA_ENC ($(du -h "$MEDIA_ENC" | cut -f1))"
    else
      echo "FATAL: media age 加密失敗 — 刪除明文 snapshot，唔留病人相喺明文中" >&2
      rm -rf "$MEDIA_SNAP" "$MEDIA_TAR"
      mark_failed "media_age_encrypt_failed"
      exit 1
    fi
  else
    echo "[backup] media snapshot OK（明文 — sandbox 軌）: $MEDIA_SNAP ($(du -sh "$MEDIA_SNAP" | cut -f1))"
  fi
else
  echo "[backup] media dir 唔存在或空（$MEDIA_DIR）— skip media snapshot"
fi

# ── 4. retention（dump + media 各清 30 日前；.age 檔同 pattern 匹配） ─────
PRUNED=$(find "$BACKUP_DIR" -maxdepth 1 -name "wa-inbox-*.dump*" -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
PRUNED_M=$(find "$BACKUP_DIR/media" -maxdepth 1 -name "wa-media-*" -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
echo "[backup] retention: pruned $PRUNED dump(s), $PRUNED_M media snapshot(s) older than ${RETENTION_DAYS}d"
# 成功 → 清失敗 flag（App health-check 見到 breach 消失 → backup_failed alert auto-resolve）
rm -f "$FAIL_FLAG"
echo "[backup] DONE"
