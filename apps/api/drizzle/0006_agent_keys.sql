ALTER TABLE "box_keys" RENAME TO "agent_keys";
--> statement-breakpoint
ALTER TABLE "agent_keys" RENAME CONSTRAINT "box_keys_pkey" TO "agent_keys_pkey";
--> statement-breakpoint
ALTER TABLE "agent_keys" RENAME CONSTRAINT "box_keys_agent_agents_id_fk" TO "agent_keys_agent_agents_id_fk";
--> statement-breakpoint
ALTER INDEX "box_keys_key_id_idx" RENAME TO "agent_keys_key_id_idx";
--> statement-breakpoint
CREATE VIEW "box_keys" AS SELECT "agent", "owner", "key_id", "signing_key", "sealing_key", "enrolled_by", "enrolled_at" FROM "agent_keys";
