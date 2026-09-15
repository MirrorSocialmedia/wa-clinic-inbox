-- AlterTable
ALTER TABLE "RoutingRule" ADD COLUMN     "treatmentTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];
