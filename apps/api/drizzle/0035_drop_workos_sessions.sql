DELETE FROM "auth_sessions" WHERE "method" = 'workos';
--> statement-breakpoint
ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_method_check";
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_method_check" CHECK ("method" IN ('google', 'microsoft'));
