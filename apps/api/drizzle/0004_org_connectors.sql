CREATE TABLE IF NOT EXISTS "connector_keys" (
	"owner" text PRIMARY KEY NOT NULL,
	"wrapped" text NOT NULL,
	"wrapping" text NOT NULL,
	"created_at" text NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth" text NOT NULL,
	"policy" text,
	"secret" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connectors_owner_name_idx" ON "connectors" USING btree ("owner","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connectors_owner_idx" ON "connectors" USING btree ("owner");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_agents" (
	"connector" text NOT NULL,
	"agent" text NOT NULL,
	"policy" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "connector_agents_connector_agent_pk" PRIMARY KEY("connector","agent"),
	CONSTRAINT "connector_agents_connector_connectors_id_fk" FOREIGN KEY ("connector") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_agents_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_agents_agent_idx" ON "connector_agents" USING btree ("agent");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"connector" text,
	"agent" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" text,
	"at" text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_events_owner_at_idx" ON "connector_events" USING btree ("owner","at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "box_keys" (
	"agent" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"key_id" text NOT NULL,
	"signing_key" text NOT NULL,
	"sealing_key" text NOT NULL,
	"enrolled_by" text NOT NULL,
	"enrolled_at" text NOT NULL,
	CONSTRAINT "box_keys_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "box_keys_key_id_idx" ON "box_keys" USING btree ("key_id");
