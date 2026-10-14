DROP TABLE "connector_events";
--> statement-breakpoint
DROP TABLE "connector_migrations";
--> statement-breakpoint
ALTER TABLE "connector_agents" DROP COLUMN "migration_operation";
