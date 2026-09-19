ALTER TABLE "agents" ADD COLUMN "slug" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_slug_idx" ON "agents" USING btree ("owner","slug");
