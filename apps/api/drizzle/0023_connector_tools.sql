CREATE TABLE IF NOT EXISTS "connector_tools" (
	"connector" text PRIMARY KEY NOT NULL,
	"tools" text,
	"listed_at" bigint,
	"failure_code" text,
	"failure" text,
	"failed_at" bigint,
	CONSTRAINT "connector_tools_connector_connectors_id_fk" FOREIGN KEY ("connector") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "connector_tools_failure_code_check" CHECK (char_length("failure_code") <= 32),
	CONSTRAINT "connector_tools_failure_check" CHECK (char_length("failure") <= 1000)
);
