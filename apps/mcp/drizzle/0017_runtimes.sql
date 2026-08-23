CREATE TABLE "runtimes" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text,
	"revoked_at" text
);
--> statement-breakpoint
ALTER TABLE "runtimes" ADD CONSTRAINT "runtimes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_id" text;
