ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'box' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "host" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_kind_check" CHECK ("kind" IN ('box', 'remote'));
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_kind_host_check" CHECK (("kind" = 'box') = ("host" IS NOT NULL));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent" text NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "agent_tokens_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_tokens_label_check" CHECK (char_length("label") BETWEEN 1 AND 64),
	CONSTRAINT "agent_tokens_token_hash_check" CHECK ("token_hash" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tokens_token_hash_idx" ON "agent_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tokens_agent_idx" ON "agent_tokens" USING btree ("agent", "created_at");
