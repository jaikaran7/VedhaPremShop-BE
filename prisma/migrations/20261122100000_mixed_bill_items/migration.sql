-- One bill can hold lines of different products (onion, ginger, garlic).
-- Each line keeps its own product, and each product says whether Amali and market fee apply to it.

ALTER TABLE "products" ADD COLUMN "applies_sale_charges" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "sale_items"
  ADD COLUMN "product_id" UUID,
  ADD COLUMN "product_name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "charges_apply" BOOLEAN NOT NULL DEFAULT true;

-- Bills already stored were single-product: copy each line's product from its lot.
UPDATE "sale_items" si
   SET "product_id" = l."product_id", "product_name" = p."name"
  FROM "lot_marks" lm
  JOIN "lots" l ON l."id" = lm."lot_id"
  JOIN "products" p ON p."id" = l."product_id"
 WHERE si."lot_mark_id" = lm."id";

ALTER TABLE "sale_items" ALTER COLUMN "product_id" SET NOT NULL;
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "sale_items_product_id_idx" ON "sale_items"("product_id");

-- Ginger and garlic carry no Amali and no market fee. Create them for every shop that does not have them yet.
INSERT INTO "products" ("organization_id", "code", "name", "applies_sale_charges")
SELECT o."id", v."code", v."name", false
  FROM "organizations" o
 CROSS JOIN (VALUES ('GINGER', 'Ginger'), ('GARLIC', 'Garlic')) AS v("code", "name")
ON CONFLICT ("organization_id", "code") DO UPDATE SET "applies_sale_charges" = false;
