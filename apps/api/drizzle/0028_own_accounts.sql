ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "name" text;
--> statement-breakpoint
UPDATE "users" SET "email" = NULL WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (PARTITION BY lower("email") ORDER BY "last_login_at" DESC NULLS LAST, "updated_at" DESC, "id") AS "rank"
		FROM "users"
		WHERE "email" IS NOT NULL
	) AS "ranked"
	WHERE "rank" > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree (lower("email"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "memberships_organization_organizations_id_fk" FOREIGN KEY ("organization") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "memberships_id_check" CHECK ("id" ~ '^om_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "memberships_role_check" CHECK ("role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_organization_user_idx" ON "memberships" USING btree ("organization", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_user_idx" ON "memberships" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	CONSTRAINT "identities_provider_subject_pk" PRIMARY KEY("provider","subject"),
	CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "identities_provider_check" CHECK ("provider" IN ('google', 'microsoft')),
	CONSTRAINT "identities_subject_check" CHECK (char_length("subject") BETWEEN 1 AND 255),
	CONSTRAINT "identities_email_check" CHECK (char_length("email") BETWEEN 3 AND 254)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identities_user_idx" ON "identities" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"method" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"previous_hash" text,
	"rotated_at" bigint,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "auth_sessions_id_check" CHECK ("id" ~ '^session_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "auth_sessions_method_check" CHECK ("method" IN ('google', 'microsoft', 'link')),
	CONSTRAINT "auth_sessions_refresh_hash_check" CHECK ("refresh_hash" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "auth_sessions_previous_hash_check" CHECK ("previous_hash" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "auth_sessions_rotation_check" CHECK (("previous_hash" IS NULL) = ("rotated_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_refresh_hash_idx" ON "auth_sessions" USING btree ("refresh_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_previous_hash_idx" ON "auth_sessions" USING btree ("previous_hash") WHERE "previous_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "login_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "login_links_id_check" CHECK ("id" ~ '^link_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "login_links_code_hash_check" CHECK ("code_hash" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "login_links_code_hash_idx" ON "login_links" USING btree ("code_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "login_links_live_idx" ON "login_links" USING btree ("user_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_links_user_idx" ON "login_links" USING btree ("user_id");
