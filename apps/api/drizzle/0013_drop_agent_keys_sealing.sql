DROP VIEW IF EXISTS "box_keys";
--> statement-breakpoint
ALTER TABLE "agent_keys" DROP COLUMN IF EXISTS "sealing_key";
