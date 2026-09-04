CREATE TABLE "vault" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"stations" jsonb NOT NULL,
	"envelope" jsonb NOT NULL,
	"synced_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vault_owner_idx" ON "vault" USING btree ("owner");
