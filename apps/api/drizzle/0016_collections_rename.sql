ALTER TABLE "connector_collections" RENAME TO "collections";--> statement-breakpoint
ALTER TABLE "connector_collection_items" RENAME TO "collection_items";--> statement-breakpoint
ALTER TABLE "collections" RENAME CONSTRAINT "connector_collections_project_id_name_unique" TO "collections_project_id_name_unique";--> statement-breakpoint
ALTER TABLE "collection_items" RENAME CONSTRAINT "connector_collection_items_collection_id_connector_id_unique" TO "collection_items_collection_id_connector_id_unique";--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT IF EXISTS "connectors_project_id_name_unique";
