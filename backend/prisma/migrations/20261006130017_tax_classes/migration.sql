-- Tax classes: products point to a named rate instead of carrying their own.
-- Lossless: every existing product is assigned the class matching its
-- current rate, so no price or total changes.

-- 1. TaxClass table
CREATE TABLE "TaxClass" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "rateBps" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaxClass_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TaxClass_name_key" ON "TaxClass"("name");
CREATE UNIQUE INDEX "TaxClass_code_key" ON "TaxClass"("code");
-- At most one default class.
CREATE UNIQUE INDEX "TaxClass_one_default" ON "TaxClass"("isDefault") WHERE "isDefault";

-- 2. One class per tax rate already used by products.
INSERT INTO "TaxClass" ("id", "name", "code", "rateBps", "sortOrder", "updatedAt")
SELECT gen_random_uuid()::text,
       CASE WHEN r = 0 THEN 'Zero-rated'
            WHEN r = 750 THEN 'VAT 7.5%'
            ELSE 'Tax ' || rtrim(rtrim(to_char(r / 100.0, 'FM990.99'), '0'), '.') || '%' END,
       CASE WHEN r = 0 THEN 'ZR' WHEN r = 750 THEN 'VAT' ELSE NULL END,
       r,
       row_number() OVER (ORDER BY r DESC),
       CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "taxRateBps" AS r FROM "Product") d;

-- 3. Nigerian stores always get VAT 7.5% (it becomes the default below).
INSERT INTO "TaxClass" ("id", "name", "code", "rateBps", "sortOrder", "updatedAt")
SELECT gen_random_uuid()::text, 'VAT 7.5%', 'VAT', 750, 0, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "TaxClass" WHERE "rateBps" = 750)
  AND (SELECT "value"->>'currency' FROM "Setting" WHERE "key" = 'store') = 'NGN';

-- 4. Default: VAT 7.5% for NGN stores, otherwise the class most products use.
--    (A brand-new store has no classes yet; store setup creates them.)
UPDATE "TaxClass" SET "isDefault" = true
WHERE "id" = (
  SELECT t."id"
  FROM "TaxClass" t LEFT JOIN "Product" p ON p."taxRateBps" = t."rateBps"
  GROUP BY t."id", t."rateBps"
  ORDER BY (t."rateBps" = 750 AND (SELECT "value"->>'currency' FROM "Setting" WHERE "key" = 'store') = 'NGN') DESC,
           count(p."id") DESC, t."rateBps" DESC
  LIMIT 1
);

-- 5. Products → class with the same rate (exactly one per rate exists).
ALTER TABLE "Product" ADD COLUMN "taxClassId" TEXT;
UPDATE "Product" p SET "taxClassId" = t."id" FROM "TaxClass" t WHERE t."rateBps" = p."taxRateBps";
ALTER TABLE "Product" ALTER COLUMN "taxClassId" SET NOT NULL;
CREATE INDEX "Product_taxClassId_idx" ON "Product"("taxClassId");
ALTER TABLE "Product" ADD CONSTRAINT "Product_taxClassId_fkey"
  FOREIGN KEY ("taxClassId") REFERENCES "TaxClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Sale lines remember the class they were sold under.
ALTER TABLE "SaleItem" ADD COLUMN "taxClassId" TEXT, ADD COLUMN "taxClassName" TEXT;
UPDATE "SaleItem" si SET "taxClassId" = t."id", "taxClassName" = t."name"
FROM "TaxClass" t WHERE t."rateBps" = si."taxRateBps";
