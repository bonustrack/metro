ALTER TABLE "mcp_approvals" ADD COLUMN IF NOT EXISTS "origin" text;
--> statement-breakpoint
ALTER TABLE "mcp_approvals" ADD COLUMN IF NOT EXISTS "token" text;
--> statement-breakpoint
ALTER TABLE "mcp_approvals" ADD CONSTRAINT "mcp_approvals_origin_check" CHECK (CASE "origin" WHEN 'key' THEN "token" IS NOT NULL WHEN 'box' THEN "token" IS NULL ELSE "origin" IS NULL AND "token" IS NULL END);
--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_approvals_pending_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_approvals_pending_idx" ON "mcp_approvals" USING btree ("agent", "connector", "tool", "args_digest", coalesce("token", '')) WHERE "state" = 'pending';
