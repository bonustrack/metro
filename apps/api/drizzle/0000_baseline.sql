CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"host" text NOT NULL,
	"name" text,
	"added_at" text NOT NULL,
	"instance_id" text,
	"launch_region" text,
	"launched_at" text,
	"avatar" text,
	"slug" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_owner_host_idx" ON "agents" USING btree ("owner","host");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_owner_slug_idx" ON "agents" USING btree ("owner","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_owner_idx" ON "agents" USING btree ("owner");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"avatar" text,
	"updated_at" text NOT NULL,
	"email" text,
	"name" text,
	"picture" text,
	"created_at" text,
	"last_login_at" text,
	"status" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_idx" ON "organizations" USING btree ("slug");
