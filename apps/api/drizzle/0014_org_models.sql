CREATE TABLE "model_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"zdr" boolean DEFAULT false NOT NULL,
	"secret" text,
	"detail" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"import_agent" text,
	"import_id" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "model_connections_provider_check" CHECK ("provider" IN ('anthropic', 'bedrock', 'openrouter', 'codex')),
	CONSTRAINT "model_connections_import_check" CHECK (("import_agent" IS NULL) = ("import_id" IS NULL)),
	CONSTRAINT "model_connections_revision_check" CHECK ("revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX "model_connections_owner_idx" ON "model_connections" USING btree ("owner");
--> statement-breakpoint
CREATE UNIQUE INDEX "model_connections_import_idx" ON "model_connections" USING btree ("import_agent", "import_id");
--> statement-breakpoint
CREATE TABLE "model_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent" text,
	"route" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "model_routes_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_routes_default_idx" ON "model_routes" USING btree ("owner") WHERE "agent" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "model_routes_agent_idx" ON "model_routes" USING btree ("agent") WHERE "agent" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "model_hosts" (
	"owner" text PRIMARY KEY NOT NULL,
	"chatgpt_host_id" text NOT NULL,
	CONSTRAINT "model_hosts_chatgpt_host_id_check" CHECK ("chatgpt_host_id" ~ '^urn:uuid:[0-9a-f-]{36}$')
);
