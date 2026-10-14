ALTER TABLE "agent_keys" ADD COLUMN "mcp_token_hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_keys_mcp_token_hash_idx" ON "agent_keys" USING btree ("mcp_token_hash") WHERE "mcp_token_hash" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "mcp_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent" text NOT NULL,
	"connector" text NOT NULL,
	"tool" text NOT NULL,
	"args_digest" text NOT NULL,
	"preview" text NOT NULL,
	"state" text NOT NULL,
	"requested_at" bigint NOT NULL,
	"answered_at" bigint,
	"delivered_at" bigint,
	CONSTRAINT "mcp_approvals_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "mcp_approvals_id_check" CHECK ("id" ~ '^[a-km-z]{5}$'),
	CONSTRAINT "mcp_approvals_state_check" CHECK ("state" IN ('pending', 'allow', 'deny', 'used', 'expired')),
	CONSTRAINT "mcp_approvals_preview_check" CHECK (char_length("preview") <= 1000)
);
--> statement-breakpoint
CREATE INDEX "mcp_approvals_agent_state_idx" ON "mcp_approvals" USING btree ("agent", "state");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_approvals_pending_idx" ON "mcp_approvals" USING btree ("agent", "connector", "tool", "args_digest") WHERE "state" = 'pending';
