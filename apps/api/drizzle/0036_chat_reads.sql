CREATE TABLE IF NOT EXISTS "chat_reads" (
	"chat" text NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"seen_seq" integer NOT NULL,
	PRIMARY KEY ("chat", "user_id")
);
--> statement-breakpoint
INSERT INTO "chat_reads" ("chat", "user_id", "seen_seq")
SELECT c."id", c."created_by", COALESCE((SELECT max(m."seq") FROM "chat_messages" m WHERE m."chat" = c."id"), 0) FROM "chats" c
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "chat_reads" ("chat", "user_id", "seen_seq")
SELECT cm."chat", cm."user_id", COALESCE((SELECT max(m."seq") FROM "chat_messages" m WHERE m."chat" = cm."chat"), 0) FROM "chat_members" cm
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "chat_reads" ("chat", "user_id", "seen_seq")
SELECT c."id", ms."user_id", COALESCE((SELECT max(m."seq") FROM "chat_messages" m WHERE m."chat" = c."id"), 0) FROM "chats" c JOIN "memberships" ms ON ms."organization" = c."owner" WHERE c."shared" = 'organization'
ON CONFLICT DO NOTHING;
