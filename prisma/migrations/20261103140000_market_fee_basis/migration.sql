-- Market fee can be a rupee rate per bag, or a percent of the product bill. New shops default to 1%.
-- Bills already stored stay per bag: that is how their market_fee_amount was calculated.

CREATE TYPE "MarketFeeBasis" AS ENUM ('PER_BAG', 'BILL_PERCENT');

ALTER TABLE "organizations"
  ADD COLUMN "market_fee_basis" "MarketFeeBasis" NOT NULL DEFAULT 'BILL_PERCENT',
  ADD COLUMN "market_fee_percent" DECIMAL(6,2) NOT NULL DEFAULT 1;

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_market_fee_percent_chk"
  CHECK ("market_fee_percent" >= 0 AND "market_fee_percent" <= 100);

ALTER TABLE "sales"
  ADD COLUMN "market_fee_basis" "MarketFeeBasis" NOT NULL DEFAULT 'PER_BAG',
  ADD COLUMN "market_fee_percent" DECIMAL(6,2) NOT NULL DEFAULT 0;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_market_fee_percent_chk"
  CHECK ("market_fee_percent" >= 0 AND "market_fee_percent" <= 100);
