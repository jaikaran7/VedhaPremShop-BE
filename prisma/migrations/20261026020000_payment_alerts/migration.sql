-- Credit follow-up windows and vendor-payment receipt / next-due date.

ALTER TABLE "organizations"
  ADD COLUMN "inactive_purchase_days" INTEGER NOT NULL DEFAULT 45,
  ADD COLUMN "payment_alert_days" INTEGER NOT NULL DEFAULT 2;

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_inactive_purchase_days_chk" CHECK ("inactive_purchase_days" BETWEEN 1 AND 365),
  ADD CONSTRAINT "organizations_payment_alert_days_chk" CHECK ("payment_alert_days" BETWEEN 1 AND 30);

ALTER TABLE "expenses"
  ADD COLUMN "next_payment_date" DATE,
  ADD COLUMN "receipt_number" TEXT;

CREATE UNIQUE INDEX "expenses_organization_id_receipt_number_key"
  ON "expenses" ("organization_id", "receipt_number")
  WHERE "receipt_number" IS NOT NULL;
