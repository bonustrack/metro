CREATE TABLE IF NOT EXISTS "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	CONSTRAINT "push_devices_platform_check" CHECK ("platform" IN ('android', 'ios')),
	CONSTRAINT "push_devices_token_check" CHECK (char_length("token") BETWEEN 1 AND 256),
	CONSTRAINT "push_devices_user_check" CHECK (char_length("user_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_devices_token_idx" ON "push_devices" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_devices_user_idx" ON "push_devices" USING btree ("user_id", "last_seen_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent" text NOT NULL,
	"approval" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text NOT NULL,
	"created_at" bigint NOT NULL,
	"next_at" bigint NOT NULL,
	"sent_at" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_outbox_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
	CONSTRAINT "push_outbox_body_check" CHECK (char_length("body") BETWEEN 1 AND 200),
	CONSTRAINT "push_outbox_url_check" CHECK (char_length("url") BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_outbox_approval_idx" ON "push_outbox" USING btree ("agent", "approval");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_outbox_due_idx" ON "push_outbox" USING btree ("next_at") WHERE "sent_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_outbox_created_idx" ON "push_outbox" USING btree ("created_at");
