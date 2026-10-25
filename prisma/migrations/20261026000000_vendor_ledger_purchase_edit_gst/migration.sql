-- AlterTable
ALTER TABLE "cash_accounts" ADD COLUMN     "opening_date" DATE NOT NULL DEFAULT CURRENT_DATE;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tax_percent" DECIMAL(6,3);

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "opening_balance" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "purchase_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "edited_by_user_id" UUID NOT NULL,
    "edited_by_name" TEXT NOT NULL,
    "edited_by_role" "UserRole" NOT NULL,
    "reason" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_revisions_purchase_id_idx" ON "purchase_revisions"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_revisions_purchase_id_revision_no_key" ON "purchase_revisions"("purchase_id", "revision_no");

-- CreateIndex
CREATE INDEX "stock_movements_organization_id_movement_date_idx" ON "stock_movements"("organization_id", "movement_date");

-- AddForeignKey
ALTER TABLE "purchase_revisions" ADD CONSTRAINT "purchase_revisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_revisions" ADD CONSTRAINT "purchase_revisions_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma's schema language cannot express.

-- GST / tax is part of the bill total.
ALTER TABLE sales DROP CONSTRAINT sales_totals;
ALTER TABLE sales ADD CONSTRAINT sales_totals CHECK (
  total_amount > 0 AND tax_amount >= 0 AND (tax_percent IS NULL OR tax_percent BETWEEN 0 AND 100)
  AND total_amount = product_subtotal + amali_amount + market_fee_amount + other_charges + tax_amount);

-- The edit history is itself history.
CREATE TRIGGER purchase_revisions_append_only BEFORE UPDATE OR DELETE ON purchase_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();

-- A vendor bill may be corrected, but only by the application inside a transaction that sets
-- vedhaprem.purchase_edit = 'on' and writes a purchase_revisions row. The receipt itself (what arrived and the
-- rates frozen at receiving) can never change, and a purchase can never be deleted.
CREATE OR REPLACE FUNCTION forbid_received_purchase_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editing boolean := coalesce(current_setting('vedhaprem.purchase_edit', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchases cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.receipt_status = 'RECEIVED' THEN
    IF NOT editing THEN
      RAISE EXCEPTION 'a received purchase is append-only; change it through a recorded edit' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.receipt_status IS DISTINCT FROM OLD.receipt_status OR NEW.receiving_record IS DISTINCT FROM OLD.receiving_record
       OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.vendor_party_id <> OLD.vendor_party_id
       OR NEW.product_id <> OLD.product_id OR NEW.lot_number <> OLD.lot_number THEN
      RAISE EXCEPTION 'the receipt of a purchase cannot be changed' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION forbid_purchase_line_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('vedhaprem.purchase_edit', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only; change it through a recorded edit', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER purchase_items_append_only ON purchase_items;
DROP TRIGGER purchase_expenses_append_only ON purchase_expenses;
CREATE TRIGGER purchase_items_guard BEFORE UPDATE OR DELETE ON purchase_items
  FOR EACH ROW EXECUTE FUNCTION forbid_purchase_line_change();
CREATE TRIGGER purchase_expenses_guard BEFORE UPDATE OR DELETE ON purchase_expenses
  FOR EACH ROW EXECUTE FUNCTION forbid_purchase_line_change();
