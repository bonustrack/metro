CREATE TABLE IF NOT EXISTS "mcp_calls" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent" text NOT NULL,
	"agent_name" text,
	"connector" text,
	"connector_key" text NOT NULL,
	"connector_name" text,
	"tool" text NOT NULL,
	"outcome" text NOT NULL,
	"ms" integer NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "mcp_calls_agent_name_check" CHECK (char_length("agent_name") <= 256),
	CONSTRAINT "mcp_calls_connector_key_check" CHECK (char_length("connector_key") <= 128),
	CONSTRAINT "mcp_calls_connector_name_check" CHECK (char_length("connector_name") <= 256),
	CONSTRAINT "mcp_calls_tool_check" CHECK (char_length("tool") <= 128),
	CONSTRAINT "mcp_calls_outcome_check" CHECK (char_length("outcome") <= 32),
	CONSTRAINT "mcp_calls_ms_check" CHECK ("ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_calls_owner_at_idx" ON "mcp_calls" USING btree ("owner", "at" DESC, "id" DESC);
