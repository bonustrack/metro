CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_id" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "users" ("email") SELECT DISTINCT "owner_email" FROM "agents" WHERE "owner_email" IS NOT NULL ORDER BY 1 ON CONFLICT ("email") DO NOTHING;--> statement-breakpoint
UPDATE "agents" SET "owner_id" = "users"."id" FROM "users" WHERE "agents"."owner_email" = "users"."email";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "owner_email";