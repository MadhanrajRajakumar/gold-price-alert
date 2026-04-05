-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('LOWEST', 'DEADLINE', 'DAILY');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "telegram_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "last_alert_sent_at" TIMESTAMP(3),
ADD COLUMN "alert_preferences" JSONB NOT NULL DEFAULT '{"daily": true, "lowest": true, "deadline": true}';

-- Preserve the old alert data before reshaping the table.
ALTER TABLE "AlertLog" RENAME TO "AlertLog_legacy";
ALTER TABLE "AlertLog_legacy" RENAME CONSTRAINT "AlertLog_pkey" TO "AlertLog_legacy_pkey";
ALTER TABLE "AlertLog_legacy" RENAME CONSTRAINT "AlertLog_user_id_fkey" TO "AlertLog_legacy_user_id_fkey";

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" SERIAL NOT NULL,
    "message" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "AlertType" NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "AlertLog_pkey" PRIMARY KEY ("id")
);

-- Best-effort migration of historical alert rows.
INSERT INTO "AlertLog" ("message", "sent_at", "type", "user_id")
SELECT
    COALESCE(
        "details",
        CONCAT('Migrated alert for ', "condition")
    ) AS "message",
    COALESCE("sent_at", CURRENT_TIMESTAMP) AS "sent_at",
    CASE
        WHEN "condition" = 'lowest-price' THEN 'LOWEST'::"AlertType"
        WHEN "condition" = 'payment-deadline' THEN 'DEADLINE'::"AlertType"
        ELSE 'DAILY'::"AlertType"
    END AS "type",
    "user_id"
FROM "AlertLog_legacy";

DROP TABLE "AlertLog_legacy";

-- AddForeignKey
ALTER TABLE "AlertLog"
ADD CONSTRAINT "AlertLog_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
