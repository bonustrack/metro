CREATE TABLE "agent_nonces" (
  "key_id" text NOT NULL,
  "nonce" text NOT NULL,
  "owner" text NOT NULL,
  "expires_at" bigint NOT NULL,
  CONSTRAINT "agent_nonces_key_id_nonce_pk" PRIMARY KEY ("key_id", "nonce")
);
--> statement-breakpoint
CREATE INDEX "agent_nonces_owner_idx" ON "agent_nonces" USING btree ("owner");
--> statement-breakpoint
CREATE INDEX "agent_nonces_expiry_idx" ON "agent_nonces" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE "agent_nonce_guard" ("id" text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO "agent_nonce_guard" ("id") VALUES ('requests');
