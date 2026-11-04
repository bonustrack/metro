CREATE TABLE IF NOT EXISTS "oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"state" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"owner" text,
	"agent" text,
	"created_by" text,
	"code_hash" text,
	CONSTRAINT "oauth_grants_agent_agents_id_fk" FOREIGN KEY ("agent") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "oauth_grants_client_id_check" CHECK (char_length("client_id") <= 4096),
	CONSTRAINT "oauth_grants_client_name_check" CHECK (char_length("client_name") BETWEEN 1 AND 64),
	CONSTRAINT "oauth_grants_redirect_uri_check" CHECK (char_length("redirect_uri") <= 2048),
	CONSTRAINT "oauth_grants_code_challenge_check" CHECK ("code_challenge" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "oauth_grants_state_check" CHECK (char_length("state") <= 2048),
	CONSTRAINT "oauth_grants_approved_check" CHECK (("code_hash" IS NULL) = ("agent" IS NULL) AND ("agent" IS NULL) = ("owner" IS NULL) AND ("owner" IS NULL) = ("created_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_grants_code_hash_idx" ON "oauth_grants" USING btree ("code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_grants_expires_idx" ON "oauth_grants" USING btree ("expires_at");
