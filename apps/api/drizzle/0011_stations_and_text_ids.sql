CREATE OR REPLACE FUNCTION metro_new_id() RETURNS text LANGUAGE sql VOLATILE AS $$
	SELECT regexp_replace(
		substr(
			translate(
				encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
				'+/', '-_'
			), 1, 11
		), '^[-_]', 'a'
	)
$$;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM "accounts" a
		LEFT JOIN "agents" g ON g."id" = a."agent_id"
		WHERE g."id" IS NULL
	) THEN
		RAISE EXCEPTION 'accounts rows reference an agent that does not exist; fix them before migrating';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "connectors" c
		LEFT JOIN "users" u ON u."id" = c."user_id"
		WHERE u."id" IS NULL
	) THEN
		RAISE EXCEPTION 'connectors rows reference a user that does not exist; fix them before migrating';
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "metro_new_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "metro_new_id" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "metro_new_id" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "metro_new_id" text;--> statement-breakpoint
UPDATE "users" SET "metro_new_id" = metro_new_id();--> statement-breakpoint
UPDATE "agents" SET "metro_new_id" = metro_new_id();--> statement-breakpoint
UPDATE "accounts" SET "metro_new_id" = metro_new_id();--> statement-breakpoint
UPDATE "connectors" SET "metro_new_id" = metro_new_id();--> statement-breakpoint
CREATE TABLE "metro_users_next" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "metro_users_next" ("id", "email")
	SELECT u."metro_new_id", u."email" FROM "users" u;
--> statement-breakpoint
CREATE TABLE "metro_agents_next" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" text,
	"key" text
);
--> statement-breakpoint
INSERT INTO "metro_agents_next" ("id", "name", "owner_id", "key")
	SELECT a."metro_new_id", a."name", u."metro_new_id", a."key"
	FROM "agents" a LEFT JOIN "users" u ON u."id" = a."owner_id";
--> statement-breakpoint
CREATE TABLE "stations" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"station" text NOT NULL,
	"account_id" text NOT NULL,
	"allowlist" text[] DEFAULT '{"*"}',
	"config" jsonb NOT NULL
);
--> statement-breakpoint
INSERT INTO "stations" ("id", "agent_id", "station", "account_id", "allowlist", "config")
	SELECT c."metro_new_id", g."metro_new_id", c."station", c."account_id", c."allowlist", c."config"
	FROM "accounts" c JOIN "agents" g ON g."id" = c."agent_id";
--> statement-breakpoint
CREATE TABLE "metro_connectors_next" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"transport" text NOT NULL,
	"config" jsonb NOT NULL
);
--> statement-breakpoint
INSERT INTO "metro_connectors_next" ("id", "user_id", "name", "url", "transport", "config")
	SELECT c."metro_new_id", u."metro_new_id", c."name", c."url", c."transport", c."config"
	FROM "connectors" c JOIN "users" u ON u."id" = c."user_id";
--> statement-breakpoint
DROP TABLE "connectors" CASCADE;--> statement-breakpoint
DROP TABLE "accounts" CASCADE;--> statement-breakpoint
DROP TABLE "agents" CASCADE;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
ALTER TABLE "metro_users_next" RENAME TO "users";--> statement-breakpoint
ALTER TABLE "metro_agents_next" RENAME TO "agents";--> statement-breakpoint
ALTER TABLE "metro_connectors_next" RENAME TO "connectors";--> statement-breakpoint
ALTER TABLE "users" RENAME CONSTRAINT "metro_users_next_pkey" TO "users_pkey";--> statement-breakpoint
ALTER TABLE "agents" RENAME CONSTRAINT "metro_agents_next_pkey" TO "agents_pkey";--> statement-breakpoint
ALTER TABLE "connectors" RENAME CONSTRAINT "metro_connectors_next_pkey" TO "connectors_pkey";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_key_unique" UNIQUE("key");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_station_account_id_unique" UNIQUE("station","account_id");--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_user_id_name_unique" UNIQUE("user_id","name");--> statement-breakpoint
DROP FUNCTION metro_new_id();
