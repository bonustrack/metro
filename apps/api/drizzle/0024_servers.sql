CREATE TABLE IF NOT EXISTS "servers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"host" text NOT NULL,
	"name" text,
	"added_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "servers_owner_host_idx" ON "servers" USING btree ("owner","host");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "servers_owner_idx" ON "servers" USING btree ("owner");
