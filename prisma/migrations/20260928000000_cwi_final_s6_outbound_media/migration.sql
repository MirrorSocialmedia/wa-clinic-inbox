-- cwi-final S6-9④（audit3 P2-03）：outbound 附件（圖片/PDF）— Message 純加 nullable 欄
-- mediaKey 已喺 S6-3②（20260927000000）有 → 唔重複加。
--
-- mediaName：文件顯示名（已清洗 cleanDocName；只 OUT document 用；唔入 log）
-- waMediaId：Graph /media 上載後嘅 id（重試唔重複上載；30 日有效）

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "mediaName" TEXT,
ADD COLUMN "waMediaId" TEXT;
