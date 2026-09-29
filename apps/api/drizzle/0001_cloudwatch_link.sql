ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "metrics_instance_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "metrics_region" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "metrics_role_arn" text;
