DROP INDEX IF EXISTS "model_connections_import_idx";
--> statement-breakpoint
ALTER TABLE "model_connections" DROP CONSTRAINT IF EXISTS "model_connections_import_check";
--> statement-breakpoint
ALTER TABLE "model_connections" DROP COLUMN IF EXISTS "import_agent";
--> statement-breakpoint
ALTER TABLE "model_connections" DROP COLUMN IF EXISTS "import_id";
