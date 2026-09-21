-- ★ cwi-final S1-13（D-6）：DraftStatus 加 EXPIRED（被第 4 個草稿擠出；唔刪；統計照計）
ALTER TYPE "DraftStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
