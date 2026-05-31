ALTER TABLE "gold_prices"
ADD COLUMN "retail_24k_price_per_gram" DOUBLE PRECISION,
ADD COLUMN "retail_22k_price_per_gram" DOUBLE PRECISION,
ADD COLUMN "retail_price_source" TEXT NOT NULL DEFAULT 'modeled_spot_multiplier';
