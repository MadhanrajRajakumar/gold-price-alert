ALTER TABLE "User"
ADD COLUMN "city" TEXT NOT NULL DEFAULT 'Chennai';

ALTER TABLE "GoldPrice"
ADD COLUMN "city" TEXT NOT NULL DEFAULT 'Chennai';

UPDATE "GoldPrice" gp
SET "city" = COALESCE(u."city", 'Chennai')
FROM "User" u
WHERE gp."user_id" = u."id";

DROP INDEX IF EXISTS "GoldPrice_user_id_date_key";
CREATE UNIQUE INDEX "GoldPrice_user_id_date_city_key" ON "GoldPrice"("user_id", "date", "city");
