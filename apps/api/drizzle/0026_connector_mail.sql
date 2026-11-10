ALTER TABLE "connector_agents" ADD COLUMN IF NOT EXISTS "senders" text DEFAULT '["*"]' NOT NULL;
--> statement-breakpoint
ALTER TABLE "connector_agents" ADD COLUMN IF NOT EXISTS "receive" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "connector_tools" ADD COLUMN IF NOT EXISTS "events" text;
--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'call' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_kind_check" CHECK ("kind" IN ('call', 'received'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"connector" text NOT NULL,
	"agent" text NOT NULL,
	"event" text NOT NULL,
	"secret" text NOT NULL,
	"server_id" text,
	"cursor" text,
	"refresh_before" bigint,
	"subscribed_at" bigint,
	"signed_in" text,
	"error" text,
	"error_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "connector_subscriptions_connector_connectors_id_fk" FOREIGN KEY ("connector") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_subscriptions_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_subscriptions_event_check" CHECK (char_length("event") BETWEEN 1 AND 128),
	CONSTRAINT "connector_subscriptions_server_id_check" CHECK (char_length("server_id") <= 256),
	CONSTRAINT "connector_subscriptions_cursor_check" CHECK (char_length("cursor") <= 8192),
	CONSTRAINT "connector_subscriptions_error_check" CHECK (char_length("error") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_subscriptions_key_idx" ON "connector_subscriptions" USING btree ("connector", "agent", "event");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_subscriptions_agent_idx" ON "connector_subscriptions" USING btree ("agent");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"connector" text NOT NULL,
	"agent" text NOT NULL,
	"event_id" text NOT NULL,
	"state" text NOT NULL,
	"mail" text,
	"received_at" bigint NOT NULL,
	"delivered_at" bigint,
	"taken_at" bigint,
	CONSTRAINT "connector_inbox_connector_connectors_id_fk" FOREIGN KEY ("connector") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_inbox_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_inbox_event_id_check" CHECK (char_length("event_id") BETWEEN 1 AND 512),
	CONSTRAINT "connector_inbox_state_check" CHECK ("state" IN ('waiting', 'delivered', 'dropped', 'expired')),
	CONSTRAINT "connector_inbox_mail_check" CHECK (("mail" IS NULL) = ("state" <> 'waiting'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_inbox_event_idx" ON "connector_inbox" USING btree ("connector", "agent", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_inbox_agent_state_idx" ON "connector_inbox" USING btree ("agent", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_inbox_received_idx" ON "connector_inbox" USING btree ("received_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" bigint NOT NULL
);
