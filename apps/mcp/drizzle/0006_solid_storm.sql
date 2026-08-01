ALTER TABLE "agents" ADD COLUMN "owner_email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_unique" ON "agents" USING btree ("name");--> statement-breakpoint
CREATE INDEX "agents_owner_email_idx" ON "agents" USING btree ("owner_email");