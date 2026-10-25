-- CreateEnum
CREATE TYPE "PurchaseReceiptStatus" AS ENUM ('PENDING_RECEIPT', 'RECEIVED');

-- CreateEnum
CREATE TYPE "CostingExpenseKind" AS ENUM ('PURCHASE', 'STOCK_RECEIVING');

-- CreateEnum
CREATE TYPE "PurchaseExpenseType" AS ENUM ('FREIGHT', 'HAMALI', 'MANDI_TAX', 'COMMISSION', 'OTHER');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "default_selling_margin_per_kg" DECIMAL(10,2) NOT NULL DEFAULT 6;

-- CreateTable
CREATE TABLE "costing_expense_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CostingExpenseKind" NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "costing_expense_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "selling_margin_components" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "per_kg" DECIMAL(10,2) NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "selling_margin_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "bill_number" TEXT NOT NULL,
    "vendor_party_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "purchase_date" DATE NOT NULL,
    "lot_number" TEXT NOT NULL,
    "expected_arrival_date" DATE,
    "gross_amount" DECIMAL(14,2) NOT NULL,
    "total_expenses" DECIMAL(14,2) NOT NULL,
    "net_amount" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "receipt_status" "PurchaseReceiptStatus" NOT NULL DEFAULT 'PENDING_RECEIPT',
    "received_at" TIMESTAMPTZ(6),
    "receiving_record" JSONB,
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "mark_code" TEXT NOT NULL,
    "bags" INTEGER NOT NULL,
    "weight_kg" DECIMAL(12,3) NOT NULL,
    "rate_per_kg" DECIMAL(10,2) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_expenses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "PurchaseExpenseType" NOT NULL DEFAULT 'OTHER',
    "expense_type_id" UUID,
    "expense_type_name" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "remarks" TEXT,

    CONSTRAINT "purchase_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "costing_expense_types_organization_id_kind_name_key" ON "costing_expense_types"("organization_id", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "selling_margin_components_organization_id_name_key" ON "selling_margin_components"("organization_id", "name");

-- CreateIndex
CREATE INDEX "purchases_organization_id_purchase_date_idx" ON "purchases"("organization_id", "purchase_date");

-- CreateIndex
CREATE INDEX "purchases_vendor_party_id_idx" ON "purchases"("vendor_party_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_organization_id_vendor_party_id_bill_number_key" ON "purchases"("organization_id", "vendor_party_id", "bill_number");

-- CreateIndex
CREATE INDEX "purchase_items_purchase_id_idx" ON "purchase_items"("purchase_id");

-- CreateIndex
CREATE INDEX "purchase_expenses_purchase_id_idx" ON "purchase_expenses"("purchase_id");

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "costing_expense_types" ADD CONSTRAINT "costing_expense_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "selling_margin_components" ADD CONSTRAINT "selling_margin_components_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_vendor_party_id_fkey" FOREIGN KEY ("vendor_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_expenses" ADD CONSTRAINT "purchase_expenses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_expenses" ADD CONSTRAINT "purchase_expenses_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_expenses" ADD CONSTRAINT "purchase_expenses_expense_type_id_fkey" FOREIGN KEY ("expense_type_id") REFERENCES "costing_expense_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Rules Prisma's schema language cannot express.
ALTER TABLE organizations ADD CONSTRAINT org_margin_non_negative CHECK (default_selling_margin_per_kg >= 0);
ALTER TABLE selling_margin_components ADD CONSTRAINT margins_non_negative CHECK (per_kg >= 0);

ALTER TABLE purchases ADD CONSTRAINT purchases_lot_upper CHECK (lot_number = upper(lot_number));
ALTER TABLE purchases ADD CONSTRAINT purchases_totals
  CHECK (gross_amount >= 0 AND total_expenses >= 0 AND net_amount = gross_amount + total_expenses);
ALTER TABLE purchases ADD CONSTRAINT purchases_receipt_consistent CHECK (
  (receipt_status = 'RECEIVED') = (receiving_record IS NOT NULL AND received_at IS NOT NULL));
ALTER TABLE purchase_items ADD CONSTRAINT purchase_items_positive
  CHECK (bags > 0 AND weight_kg > 0 AND rate_per_kg >= 0 AND total_amount >= 0 AND mark_code = upper(mark_code));
ALTER TABLE purchase_expenses ADD CONSTRAINT purchase_expenses_non_negative CHECK (amount >= 0);

-- A posted vendor bill is history: it can be received once, never edited or deleted afterwards.
CREATE OR REPLACE FUNCTION forbid_received_purchase_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchases cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.receipt_status = 'RECEIVED' THEN
    RAISE EXCEPTION 'a received purchase is append-only' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchases_received_immutable BEFORE UPDATE OR DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION forbid_received_purchase_change();
CREATE TRIGGER purchase_items_append_only BEFORE UPDATE OR DELETE ON purchase_items
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();
CREATE TRIGGER purchase_expenses_append_only BEFORE UPDATE OR DELETE ON purchase_expenses
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();
