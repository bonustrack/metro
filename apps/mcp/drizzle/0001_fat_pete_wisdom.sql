ALTER TABLE "accounts" ADD COLUMN "allowlist" text[] DEFAULT '{"*"}';--> statement-breakpoint
UPDATE "accounts" SET "allowlist" = '{"*"}' WHERE "allowlist" IS NULL;