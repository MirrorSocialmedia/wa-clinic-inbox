-- §D（cwi-r2）：AvailabilitySlot 加 remainingCapacity（nullable — workforce 未上 capacity 前缺欄，fallback 當 1）
-- AlterTable
ALTER TABLE "AvailabilitySlot" ADD COLUMN "remainingCapacity" INTEGER;
