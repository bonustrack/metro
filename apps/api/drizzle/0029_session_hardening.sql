ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_method_check";
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_method_check" CHECK ("method" IN ('google', 'microsoft', 'link', 'workos'));
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "link" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_link_idx" ON "auth_sessions" USING btree ("link") WHERE "link" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_spent_tokens" (
	"hash" text PRIMARY KEY NOT NULL,
	"session" text NOT NULL,
	"spent_at" bigint NOT NULL,
	CONSTRAINT "auth_spent_tokens_session_auth_sessions_id_fk" FOREIGN KEY ("session") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "auth_spent_tokens_hash_check" CHECK ("hash" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_spent_tokens_session_idx" ON "auth_spent_tokens" USING btree ("session");
--> statement-breakpoint
ALTER TABLE "login_links" ADD COLUMN IF NOT EXISTS "expires_at" bigint;
--> statement-breakpoint
ALTER TABLE "login_links" ADD COLUMN IF NOT EXISTS "used_at" bigint;
--> statement-breakpoint
DROP INDEX IF EXISTS "login_links_live_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "login_links_open_idx" ON "login_links" USING btree ("user_id") WHERE "revoked_at" IS NULL AND "used_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "added_by" text;
