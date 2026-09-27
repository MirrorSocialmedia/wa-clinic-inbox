# docs/drills — 演習記錄（cwi-final S6-4）

每月 restore drill 記錄放呢度。

## Restore drill（每月一次）

目的：證明 backup 真係 restore 得返（dump 檔 + age key + migrate 全鏈路），唔好等真出事先發現 restore 唔到。

### 程序

1. 確保有近期 backup（`ls .dev/backups/wa-inbox-*.dump*`；VPS = production BACKUP_DIR）
2. 跑：
   ```bash
   bash scripts/restore-wa-test.sh
   # 指定 dump：bash scripts/restore-wa-test.sh .dev/backups/wa-inbox-XXXXXXXX-XXXXXX.dump.age
   ```
   - restore 落 **scratch DB** `wa_inbox_restore_test`（唔會郁生產 DB；跑完自動清）
   - 抽 5 表（Message / Conversation / Contact / AiDraft / BookingRequest）row count 同源 DB 對
   - 成功 = exit 0 + `RESTORE-TEST OK` + drill 記錄自動 append 入 `docs/drills/restore-drill-YYYY-MM.md`
3. 失敗 → 查 log（/tmp/wa-restore-*.log）→ 修好再跑（drill 唔成功 = 當月 drill 未完成）

### 排程建議（VPS crontab，每月 1 號）

```cron
0 4 1 * * cd /srv/wa-clinic-inbox && bash scripts/restore-wa-test.sh >> /var/log/wa-restore-drill.log 2>&1
```

跑完人眼核 `docs/drills/restore-drill-YYYY-MM.md` 有冇當日 OK 記錄（commit 入 repo 留痕）。
