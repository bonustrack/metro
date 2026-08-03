ALTER TABLE "agents" ADD COLUMN "owner_email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_name_unique" ON "agents" USING btree ("owner_email","name");