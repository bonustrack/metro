CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_unique" UNIQUE("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "projects" ("id", "name", "owner_id", "is_default")
SELECT substr(md5(random()::text || "id"), 1, 11), 'Personal', "id", true FROM "users";--> statement-breakpoint
INSERT INTO "project_members" ("id", "project_id", "user_id", "role")
SELECT substr(md5(random()::text || p."id"), 1, 11), p."id", p."owner_id", 'admin' FROM "projects" p;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "project_id" text;--> statement-breakpoint
UPDATE "agents" a SET "project_id" = p."id" FROM "projects" p WHERE p."owner_id" = a."owner_id";--> statement-breakpoint
UPDATE "agents" SET "project_id" = (
  SELECT p."id" FROM "projects" p
  JOIN "users" u ON u."id" = p."owner_id"
  WHERE p."is_default" ORDER BY u."id" LIMIT 1
) WHERE "project_id" IS NULL;--> statement-breakpoint
DELETE FROM "agents" WHERE "project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_owner_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "project_id" text;--> statement-breakpoint
UPDATE "connectors" c SET "project_id" = p."id" FROM "projects" p WHERE p."owner_id" = c."user_id";--> statement-breakpoint
DELETE FROM "connectors" WHERE "project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "connectors" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT IF EXISTS "connectors_user_id_name_unique";--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT IF EXISTS "connectors_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_project_id_name_unique" UNIQUE("project_id","name");--> statement-breakpoint
ALTER TABLE "connector_collections" ADD COLUMN "project_id" text;--> statement-breakpoint
UPDATE "connector_collections" c SET "project_id" = p."id" FROM "projects" p WHERE p."owner_id" = c."user_id";--> statement-breakpoint
DELETE FROM "connector_collections" WHERE "project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "connector_collections" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_collections" DROP CONSTRAINT IF EXISTS "connector_collections_user_id_name_unique";--> statement-breakpoint
ALTER TABLE "connector_collections" DROP CONSTRAINT IF EXISTS "connector_collections_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "connector_collections" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "connector_collections" ADD CONSTRAINT "connector_collections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_collections" ADD CONSTRAINT "connector_collections_project_id_name_unique" UNIQUE("project_id","name");
