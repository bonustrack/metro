ALTER TABLE "users" ADD COLUMN "status" text;--> statement-breakpoint
UPDATE "users" SET "status" = 'approved' WHERE "status" IS NULL;
