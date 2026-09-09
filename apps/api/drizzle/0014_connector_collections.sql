CREATE TABLE "connector_collection_items" (
	"id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"connector_id" text NOT NULL,
	CONSTRAINT "connector_collection_items_collection_id_connector_id_unique" UNIQUE("collection_id","connector_id")
);
--> statement-breakpoint
CREATE TABLE "connector_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "connector_collections_user_id_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "connector_collection_items" ADD CONSTRAINT "connector_collection_items_collection_id_connector_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."connector_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_collection_items" ADD CONSTRAINT "connector_collection_items_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_collections" ADD CONSTRAINT "connector_collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;