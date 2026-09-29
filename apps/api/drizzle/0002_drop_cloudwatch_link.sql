ALTER TABLE "agents" DROP COLUMN IF EXISTS "metrics_instance_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "metrics_region";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "metrics_role_arn";
