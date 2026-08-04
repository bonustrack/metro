ALTER TABLE "agents" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_key_unique" UNIQUE("key");--> statement-breakpoint
UPDATE "agents" SET "key" = "one"."key" FROM (SELECT DISTINCT ON ("agent_id") "agent_id", "key" FROM "keys" ORDER BY "agent_id", "name") AS "one" WHERE "agents"."id" = "one"."agent_id";--> statement-breakpoint
DROP TABLE "keys";
