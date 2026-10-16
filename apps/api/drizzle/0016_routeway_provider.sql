ALTER TABLE "model_connections" DROP CONSTRAINT IF EXISTS "model_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_provider_check" CHECK ("provider" IN ('anthropic', 'bedrock', 'openrouter', 'codex', 'routeway'));
