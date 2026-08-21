UPDATE "stations"
SET "config" = "config" || jsonb_build_object('previousAccountId', "account_id")
WHERE "account_id" <> "id";
--> statement-breakpoint
ALTER TABLE "stations" DROP CONSTRAINT "stations_station_account_id_unique";--> statement-breakpoint
ALTER TABLE "stations" DROP COLUMN "account_id";
