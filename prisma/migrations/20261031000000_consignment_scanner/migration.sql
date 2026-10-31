-- CreateEnum
CREATE TYPE "BillRateUnit" AS ENUM ('PER_KG', 'PER_10_KG', 'PER_BAG');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('DRAFT', 'PROCESSING', 'NEEDS_REVIEW', 'READY', 'FAILED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ScanDocumentKind" AS ENUM ('VENDOR_BILL', 'MARK_SHEET');

-- CreateEnum
CREATE TYPE "ScanRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ScanConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ScanExpenseCategory" AS ENUM ('HAMALI', 'MARKET_FEE', 'COMMISSION', 'LEVY', 'DRIVER_ADVANCE', 'FREIGHT', 'OTHER');

-- CreateEnum
CREATE TYPE "ScanIssueSeverity" AS ENUM ('CRITICAL', 'WARNING', 'INFO');

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "bill_rate_unit" "BillRateUnit";

-- CreateTable
CREATE TABLE "consignment_scans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "vendor_party_id" UUID,
    "product_id" UUID,
    "lot_number" TEXT,
    "rate_unit" "BillRateUnit",
    "bill_number" TEXT,
    "bill_date" DATE,
    "sheet_date" DATE,
    "vendor_name_text" TEXT,
    "buyer_name_text" TEXT,
    "lot_ref_text" TEXT,
    "printed_bill_bags" INTEGER,
    "printed_bill_grams" BIGINT,
    "printed_gross_paise" BIGINT,
    "printed_expenses_paise" BIGINT,
    "printed_net_paise" BIGINT,
    "printed_sheet_bags" INTEGER,
    "header_evidence" JSONB,
    "reconciliation" JSONB,
    "purchase_id" UUID,
    "confirm_key" TEXT,
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "confirmed_by_name" TEXT,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consignment_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consignment_scan_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "kind" "ScanDocumentKind" NOT NULL,
    "page_no" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consignment_scan_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consignment_scan_files" (
    "document_id" UUID NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "consignment_scan_files_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "consignment_scan_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "job" "ScanDocumentKind" NOT NULL,
    "status" "ScanRunStatus" NOT NULL DEFAULT 'RUNNING',
    "stage" TEXT NOT NULL DEFAULT 'QUEUED',
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "error" TEXT,
    "raw_response" JSONB,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "consignment_scan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consignment_scan_bill_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "item_name" TEXT NOT NULL DEFAULT '',
    "bags" INTEGER NOT NULL,
    "grams" BIGINT NOT NULL,
    "rate_paise" BIGINT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "source_page" INTEGER,
    "source_row" INTEGER,
    "confidence" "ScanConfidence" NOT NULL DEFAULT 'HIGH',
    "raw_text" JSONB,
    "origin" TEXT NOT NULL DEFAULT 'AI',
    "corrected" BOOLEAN NOT NULL DEFAULT false,
    "assigned_mark_id" UUID,

    CONSTRAINT "consignment_scan_bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consignment_scan_expenses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "category" "ScanExpenseCategory" NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "include_in_cost" BOOLEAN NOT NULL DEFAULT true,
    "confidence" "ScanConfidence" NOT NULL DEFAULT 'HIGH',
    "raw_text" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'AI',
    "corrected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "consignment_scan_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consignment_scan_marks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "mark_code" TEXT NOT NULL,
    "bags" INTEGER NOT NULL,
    "rate_min_paise" BIGINT NOT NULL,
    "rate_max_paise" BIGINT NOT NULL,
    "source_page" INTEGER,
    "source_row" INTEGER,
    "confidence" "ScanConfidence" NOT NULL DEFAULT 'HIGH',
    "raw_text" JSONB,
    "origin" TEXT NOT NULL DEFAULT 'AI',
    "corrected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "consignment_scan_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consignment_scan_issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "severity" "ScanIssueSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "refs" JSONB,

    CONSTRAINT "consignment_scan_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consignment_scan_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "edited_by_name" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consignment_scan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consignment_scans_purchase_id_key" ON "consignment_scans"("purchase_id");

-- CreateIndex
CREATE INDEX "consignment_scans_organization_id_created_at_idx" ON "consignment_scans"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "consignment_scans_organization_id_confirm_key_key" ON "consignment_scans"("organization_id", "confirm_key");

-- CreateIndex
CREATE INDEX "consignment_scan_documents_scan_id_idx" ON "consignment_scan_documents"("scan_id");

-- CreateIndex
CREATE UNIQUE INDEX "consignment_scan_documents_scan_id_sha256_key" ON "consignment_scan_documents"("scan_id", "sha256");

-- CreateIndex
CREATE INDEX "consignment_scan_runs_scan_id_started_at_idx" ON "consignment_scan_runs"("scan_id", "started_at");

-- CreateIndex
CREATE INDEX "consignment_scan_bill_lines_scan_id_idx" ON "consignment_scan_bill_lines"("scan_id");

-- CreateIndex
CREATE INDEX "consignment_scan_expenses_scan_id_idx" ON "consignment_scan_expenses"("scan_id");

-- CreateIndex
CREATE INDEX "consignment_scan_marks_scan_id_idx" ON "consignment_scan_marks"("scan_id");

-- CreateIndex
CREATE INDEX "consignment_scan_issues_scan_id_idx" ON "consignment_scan_issues"("scan_id");

-- CreateIndex
CREATE UNIQUE INDEX "consignment_scan_versions_scan_id_version_key" ON "consignment_scan_versions"("scan_id", "version");

-- AddForeignKey
ALTER TABLE "consignment_scans" ADD CONSTRAINT "consignment_scans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scans" ADD CONSTRAINT "consignment_scans_vendor_party_id_fkey" FOREIGN KEY ("vendor_party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scans" ADD CONSTRAINT "consignment_scans_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scans" ADD CONSTRAINT "consignment_scans_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scan_documents" ADD CONSTRAINT "consignment_scan_documents_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "consignment_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scan_files" ADD CONSTRAINT "consignment_scan_files_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "consignment_scan_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scan_runs" ADD CONSTRAINT "consignment_scan_runs_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "consignment_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scan_bill_lines" ADD CONSTRAINT "consignment_scan_bill_lines_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "consignment_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scan_expenses" ADD CONSTRAINT "consignment_scan_expenses_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "consignment_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scan_marks" ADD CONSTRAINT "consignment_scan_marks_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "consignment_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scan_issues" ADD CONSTRAINT "consignment_scan_issues_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "consignment_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_scan_versions" ADD CONSTRAINT "consignment_scan_versions_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "consignment_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written integrity rules (not expressible in the Prisma schema).
ALTER TABLE consignment_scans ADD CONSTRAINT scans_confirmed_has_purchase
  CHECK ((status = 'CONFIRMED') = (purchase_id IS NOT NULL AND confirmed_at IS NOT NULL));
ALTER TABLE consignment_scans ADD CONSTRAINT scans_version_positive CHECK (version >= 1);
ALTER TABLE consignment_scan_documents ADD CONSTRAINT scan_docs_valid
  CHECK (size_bytes > 0 AND page_no >= 1 AND sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE consignment_scan_bill_lines ADD CONSTRAINT scan_lines_non_negative
  CHECK (bags >= 0 AND grams >= 0 AND rate_paise >= 0 AND amount_paise >= 0 AND origin IN ('AI', 'MANUAL'));
ALTER TABLE consignment_scan_expenses ADD CONSTRAINT scan_expenses_non_negative
  CHECK (amount_paise >= 0 AND origin IN ('AI', 'MANUAL'));
ALTER TABLE consignment_scan_marks ADD CONSTRAINT scan_marks_valid
  CHECK (bags >= 0 AND rate_min_paise >= 0 AND rate_max_paise >= rate_min_paise AND origin IN ('AI', 'MANUAL'));

-- A confirmed scan is the record behind a posted purchase: it can no longer change or be deleted.
CREATE FUNCTION consignment_scan_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'CONFIRMED' THEN
    RAISE EXCEPTION 'A confirmed consignment scan cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consignment_scans_frozen BEFORE UPDATE OR DELETE ON consignment_scans
  FOR EACH ROW EXECUTE FUNCTION consignment_scan_frozen();
