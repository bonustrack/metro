CREATE TABLE "agent_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"connector_id" text NOT NULL,
	CONSTRAINT "agent_connectors_agent_id_connector_id_unique" UNIQUE("agent_id","connector_id")
);
--> statement-breakpoint
ALTER TABLE "agent_connectors" ADD CONSTRAINT "agent_connectors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connectors" ADD CONSTRAINT "agent_connectors_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "agent_connectors" ("id", "agent_id", "connector_id")
SELECT
	substr(replace(gen_random_uuid()::text, '-', ''), 1, 1) || substr(translate(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/', '-_'), 1, 10),
	"a"."id",
	"ci"."connector_id"
FROM "collection_items" "ci"
JOIN "connectors" "c" ON "c"."id" = "ci"."connector_id"
JOIN "agents" "a" ON "a"."id" = 'bMcXH2uERTe' AND "a"."project_id" = "c"."project_id"
WHERE "ci"."collection_id" = 'tnlSpfBErt0'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE "collection_items";--> statement-breakpoint
DROP TABLE "collections";
