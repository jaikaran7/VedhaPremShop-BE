CREATE TYPE "ExpenseAmountBasis" AS ENUM ('FIXED_TOTAL', 'PER_BAG', 'PER_KG');

ALTER TABLE "costing_expense_types"
  ADD COLUMN "amount_basis" "ExpenseAmountBasis" NOT NULL DEFAULT 'FIXED_TOTAL',
  ADD COLUMN "default_allocation" TEXT NOT NULL DEFAULT 'BY_RECEIVED_KG';

-- Per-bag types charge each bag. Transport and commission stay a fixed total.
UPDATE "costing_expense_types"
SET "amount_basis" = 'PER_BAG', "default_allocation" = 'BY_RECEIVED_BAGS'
WHERE "kind" = 'STOCK_RECEIVING'
  AND lower("name") IN ('loading', 'unloading', 'loading/unloading', 'hamali', 'labour', 'labor');

ALTER TABLE "purchases" ADD COLUMN "receiving_draft" JSONB;
