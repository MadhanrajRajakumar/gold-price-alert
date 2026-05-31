DROP TABLE IF EXISTS "GoldPrice";

CREATE TABLE "gold_prices" (
    "id" SERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "price_per_gram" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gold_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gold_prices_timestamp_key" ON "gold_prices"("timestamp");
CREATE INDEX "gold_prices_timestamp_idx" ON "gold_prices"("timestamp");

CREATE TABLE "daily_summary" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "open_price" DOUBLE PRECISION NOT NULL,
    "high_price" DOUBLE PRECISION NOT NULL,
    "low_price" DOUBLE PRECISION NOT NULL,
    "close_price" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'aggregation',
    "validated_at" TIMESTAMP(3),
    "validation_status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_summary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daily_summary_date_key" ON "daily_summary"("date");
CREATE INDEX "daily_summary_date_idx" ON "daily_summary"("date");

CREATE TABLE "system_job_runs" (
    "id" SERIAL NOT NULL,
    "job_name" TEXT NOT NULL,
    "last_started_at" TIMESTAMP(3),
    "last_completed_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'idle',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_job_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_job_runs_job_name_key" ON "system_job_runs"("job_name");
