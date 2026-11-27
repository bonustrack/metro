CREATE TABLE IF NOT EXISTS "chats" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"agent" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"shared" text DEFAULT 'private' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "chats_shared_check" CHECK ("shared" IN ('private', 'organization'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chats_owner_updated_idx" ON "chats" USING btree ("owner", "updated_at" DESC, "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chats_agent_idx" ON "chats" USING btree ("agent");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_members" (
	"chat" text NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" bigint NOT NULL,
	PRIMARY KEY ("chat", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_members_user_idx" ON "chat_members" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_pins" (
	"user_id" text NOT NULL,
	"chat" text NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
	"pinned_at" bigint NOT NULL,
	PRIMARY KEY ("user_id", "chat")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_pins_chat_idx" ON "chat_pins" USING btree ("chat");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"chat" text NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"author" text,
	"reply_to" text,
	"body" text NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "chat_messages_role_check" CHECK (("role" = 'user' AND "author" IS NOT NULL AND "reply_to" IS NULL) OR ("role" = 'assistant' AND "author" IS NULL AND "reply_to" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_messages_seq_idx" ON "chat_messages" USING btree ("chat", "seq");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_messages_reply_idx" ON "chat_messages" USING btree ("chat", "reply_to");
