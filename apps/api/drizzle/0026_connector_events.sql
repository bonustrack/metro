ALTER TABLE "connector_agents" ADD COLUMN IF NOT EXISTS "events" text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE "connector_agents" ADD COLUMN IF NOT EXISTS "senders" text DEFAULT '["*"]' NOT NULL;
--> statement-breakpoint
ALTER TABLE "connector_tools" ADD COLUMN IF NOT EXISTS "events" text;
--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'call' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_calls" DROP CONSTRAINT IF EXISTS "mcp_calls_kind_check";
--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_kind_check" CHECK ("kind" IN ('call', 'event')) NOT VALID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"connector" text NOT NULL,
	"agent" text NOT NULL,
	"event" text NOT NULL,
	"secret" text NOT NULL,
	"cursor" text,
	"sender" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"signed_in" text NOT NULL,
	"next_at" bigint DEFAULT 0 NOT NULL,
	"claimed_until" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "connector_subscriptions_connector_connectors_id_fk" FOREIGN KEY ("connector") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_subscriptions_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_subscriptions_event_check" CHECK (char_length("event") BETWEEN 1 AND 128),
	CONSTRAINT "connector_subscriptions_cursor_check" CHECK (char_length("cursor") <= 8192),
	CONSTRAINT "connector_subscriptions_sender_check" CHECK (char_length("sender") <= 1024),
	CONSTRAINT "connector_subscriptions_status_check" CHECK ("status" IN ('pending', 'active', 'signed_out', 'error')),
	CONSTRAINT "connector_subscriptions_error_check" CHECK (char_length("error") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_subscriptions_key_idx" ON "connector_subscriptions" USING btree ("connector", "agent", "event");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_subscriptions_agent_idx" ON "connector_subscriptions" USING btree ("agent");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_events" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"owner" text NOT NULL,
	"connector" text NOT NULL,
	"agent" text NOT NULL,
	"subscription" text NOT NULL,
	"event" text NOT NULL,
	"event_id" text NOT NULL,
	"body" text,
	"received_at" bigint NOT NULL,
	"delivered_at" bigint,
	CONSTRAINT "connector_events_connector_connectors_id_fk" FOREIGN KEY ("connector") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_events_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_events_event_check" CHECK (char_length("event") BETWEEN 1 AND 128),
	CONSTRAINT "connector_events_event_id_check" CHECK (char_length("event_id") BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_events_key_idx" ON "connector_events" USING btree ("subscription", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_events_waiting_idx" ON "connector_events" USING btree ("agent", "seq") WHERE "body" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_events_received_idx" ON "connector_events" USING btree ("received_at");
