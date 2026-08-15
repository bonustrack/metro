CREATE TABLE "agent_reports" (
	"agent_id" integer PRIMARY KEY NOT NULL,
	"rows" jsonb NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
