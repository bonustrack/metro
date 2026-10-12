ALTER TABLE "connector_agents" ADD COLUMN "migration_operation" text;
--> statement-breakpoint
CREATE TABLE "connector_migrations" (
  "id" text PRIMARY KEY NOT NULL,
  "owner" text NOT NULL,
  "agent" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "source_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "destination_id" text NOT NULL,
  "key_id" text NOT NULL,
  "signing_key" text NOT NULL,
  "sealing_key" text NOT NULL,
  "enrolled_at" text NOT NULL,
  "phase" text NOT NULL CHECK ("phase" IN ('preparing', 'prepared', 'active', 'rolled_back')),
  "receiving_key" text NOT NULL,
  "receiving_secret" text NOT NULL,
  "snapshot" text,
  "config_stamp" text,
  "retired_operations" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_migrations_source_idx" ON "connector_migrations" ("owner", "agent", "source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_migrations_operation_idx" ON "connector_migrations" ("operation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_migrations_destination_idx" ON "connector_migrations" ("destination_id");
