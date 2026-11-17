DROP INDEX IF EXISTS "auth_sessions_link_idx";
--> statement-breakpoint
ALTER TABLE "auth_sessions" DROP COLUMN IF EXISTS "link";
