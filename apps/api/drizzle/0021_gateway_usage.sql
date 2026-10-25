ALTER TABLE "agent_tokens" ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT '{connectors}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_scopes_check" CHECK (cardinality("scopes") >= 1 AND "scopes" <@ ARRAY['connectors', 'gateway']::text[]);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_calls" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent" text NOT NULL,
	"agent_name" text,
	"origin" text NOT NULL,
	"token" text,
	"lane" text NOT NULL,
	"kind" text NOT NULL,
	"connection" text,
	"provider" text,
	"model" text NOT NULL,
	"attempt" smallint NOT NULL,
	"outcome" text NOT NULL,
	"status" smallint NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_5m_tokens" integer NOT NULL,
	"cache_write_1h_tokens" integer NOT NULL,
	"cost_micros" bigint,
	"ms" integer NOT NULL,
	"first_token_ms" integer,
	"at" bigint NOT NULL,
	CONSTRAINT "model_calls_origin_check" CHECK ("origin" IN ('box', 'key') AND ("origin" = 'key') = ("token" IS NOT NULL)),
	CONSTRAINT "model_calls_lane_check" CHECK ("lane" IN ('main', 'workers')),
	CONSTRAINT "model_calls_kind_check" CHECK (char_length("kind") <= 32),
	CONSTRAINT "model_calls_outcome_check" CHECK (char_length("outcome") <= 32),
	CONSTRAINT "model_calls_agent_name_check" CHECK (char_length("agent_name") <= 256),
	CONSTRAINT "model_calls_provider_check" CHECK (char_length("provider") <= 32),
	CONSTRAINT "model_calls_model_check" CHECK (char_length("model") <= 256),
	CONSTRAINT "model_calls_counts_check" CHECK ("attempt" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_write_5m_tokens" >= 0 AND "cache_write_1h_tokens" >= 0 AND "ms" >= 0 AND ("first_token_ms" IS NULL OR "first_token_ms" >= 0) AND ("cost_micros" IS NULL OR "cost_micros" >= 0))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_calls_owner_at_idx" ON "model_calls" USING btree ("owner", "at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_calls_owner_agent_at_idx" ON "model_calls" USING btree ("owner", "agent", "at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_calls_owner_connection_at_idx" ON "model_calls" USING btree ("owner", "connection", "at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_windows" (
	"owner" text NOT NULL,
	"connection" text NOT NULL,
	"label" text NOT NULL,
	"used" real,
	"reset_at" bigint,
	"detail" text,
	"at" bigint NOT NULL,
	CONSTRAINT "model_windows_pk" PRIMARY KEY ("connection", "label"),
	CONSTRAINT "model_windows_label_check" CHECK (char_length("label") <= 128),
	CONSTRAINT "model_windows_detail_check" CHECK (char_length("detail") <= 256)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_windows_owner_idx" ON "model_windows" USING btree ("owner");
