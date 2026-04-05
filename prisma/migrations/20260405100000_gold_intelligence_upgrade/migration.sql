ALTER TABLE "User"
ADD COLUMN "onboarding_completed_at" TIMESTAMP(3);

ALTER TABLE "GoldPrice"
ADD COLUMN "min_price" DOUBLE PRECISION,
ADD COLUMN "max_price" DOUBLE PRECISION,
ADD COLUMN "confidence" INTEGER,
ADD COLUMN "source_summary" JSONB;

UPDATE "GoldPrice"
SET
  "min_price" = "price_per_gram",
  "max_price" = "price_per_gram",
  "source_summary" = jsonb_build_object(
    'sources', jsonb_build_array("source"),
    'sources_count', 1
  )
WHERE "min_price" IS NULL
   OR "max_price" IS NULL
   OR "source_summary" IS NULL;
