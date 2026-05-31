ALTER TABLE "gold_prices"
ADD COLUMN IF NOT EXISTS "retail_price_model_version" TEXT NOT NULL DEFAULT 'spot_multiplier_v1';
