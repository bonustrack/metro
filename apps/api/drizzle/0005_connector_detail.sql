ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "detail" text;
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "auth_generation" text;
