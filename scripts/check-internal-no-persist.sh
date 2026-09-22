#!/usr/bin/env bash
# check-internal-no-persist — cwi-final S2-9 防落地 CI 守門
#
# 鐵律：臨床全文唔准落地。`src/app/api/internal/**` 同 `src/lib/internal/**`
# 唔准出現 prisma import / prisma 調用 / auditLog / console.log：
#   - @/lib/prisma  → 禁 DB import（proxy route 零 DB 寫入，T623 驗 count 不變）
#   - prisma\.      → 禁任何 prisma client 調用
#   - auditLog      → 禁審計寫入（同理零 DB）
#   - console\.log  → 禁 console 直寫 log（要經 @/lib/log 鐵律 redact 層；
#                     而 internal 層更嚴：連 metadata log 都只准 @/lib/log 白名單行）
#
# 用法（repo root）：bash scripts/check-internal-no-persist.sh
# 退出碼：0 = 乾淨；1 = 有 violation。已接入 pnpm audit:gate。
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERNS=("@/lib/prisma" "prisma\." "auditLog" "console\.log")
HITS=0

if ! ls src/app/api/internal 2>/dev/null | grep -q . && ! ls src/lib/internal 2>/dev/null | grep -q .; then
  echo "check-internal-no-persist: SKIP（src/app/api/internal 同 src/lib/internal 都唔存在）"
  exit 0
fi

for f in $(find src/app/api/internal src/lib/internal -name '*.ts' 2>/dev/null | sort); do
  for p in "${PATTERNS[@]}"; do
    if grep -nE "$p" "$f" >/dev/null 2>&1; then
      echo "VIOLATION: $f 出現禁用 pattern: $p"
      grep -nE "$p" "$f" | sed 's/^/    /'
      HITS=1
    fi
  done
done

if [ "$HITS" = "0" ]; then
  echo "check-internal-no-persist: OK（src/app/api/internal + src/lib/internal 零 prisma / auditLog / console.log）"
else
  echo "check-internal-no-persist: FAILED — 見上 VIOLATION"
  exit 1
fi
