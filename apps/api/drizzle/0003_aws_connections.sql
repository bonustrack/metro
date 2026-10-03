CREATE TABLE IF NOT EXISTS "aws_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"account_id" text NOT NULL,
	"role_arn" text NOT NULL,
	"added_at" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "aws_connections_owner_account_idx" ON "aws_connections" USING btree ("owner","account_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "aws_external_ids" (
	"owner" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"created_at" text NOT NULL
);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "aws_connection" text;
