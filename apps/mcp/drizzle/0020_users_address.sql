ALTER TABLE "users" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_address_unique" UNIQUE("address");--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
UPDATE "users" SET "address" = '0xef8305e140ac520225daf050e2f71d5fbcc543e7' WHERE "email" = 'fabien@bonustrack.co';--> statement-breakpoint
DO $$
BEGIN
	IF (SELECT count(*) FROM "users") > 0 AND (SELECT count(*) FROM "users" WHERE "address" IS NOT NULL) = 0 THEN
		RAISE EXCEPTION 'no user carries an address; refusing to remove every account';
	END IF;
END $$;--> statement-breakpoint
CREATE TEMP TABLE "gone_users" AS SELECT "id" FROM "users" WHERE "address" IS NULL;--> statement-breakpoint
CREATE TEMP TABLE "gone_projects" AS SELECT "id" FROM "projects" WHERE "owner_id" IN (SELECT "id" FROM "gone_users");--> statement-breakpoint
DELETE FROM "stations" WHERE "agent_id" IN (SELECT "id" FROM "agents" WHERE "project_id" IN (SELECT "id" FROM "gone_projects"));--> statement-breakpoint
DELETE FROM "agents" WHERE "project_id" IN (SELECT "id" FROM "gone_projects");--> statement-breakpoint
DELETE FROM "connectors" WHERE "project_id" IN (SELECT "id" FROM "gone_projects");--> statement-breakpoint
DELETE FROM "project_members" WHERE "user_id" IN (SELECT "id" FROM "gone_users") OR "project_id" IN (SELECT "id" FROM "gone_projects");--> statement-breakpoint
DELETE FROM "projects" WHERE "id" IN (SELECT "id" FROM "gone_projects");--> statement-breakpoint
DELETE FROM "users" WHERE "id" IN (SELECT "id" FROM "gone_users");--> statement-breakpoint
DROP TABLE "gone_projects";--> statement-breakpoint
DROP TABLE "gone_users";
