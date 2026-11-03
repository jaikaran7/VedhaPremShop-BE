-- CreateTable
CREATE TABLE "sale_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "edited_by_user_id" UUID NOT NULL,
    "edited_by_name" TEXT NOT NULL,
    "edited_by_role" "UserRole" NOT NULL,
    "reason" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_revisions_sale_id_idx" ON "sale_revisions"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_revisions_sale_id_revision_no_key" ON "sale_revisions"("sale_id", "revision_no");

-- AddForeignKey
ALTER TABLE "sale_revisions" ADD CONSTRAINT "sale_revisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_revisions" ADD CONSTRAINT "sale_revisions_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The edit history is itself history.
CREATE TRIGGER sale_revisions_append_only BEFORE UPDATE OR DELETE ON sale_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();
