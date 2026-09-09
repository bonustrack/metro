CREATE TABLE "whatsapp_auth" (
	"account_id" text NOT NULL,
	"category" text NOT NULL,
	"item_id" text DEFAULT '' NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_auth_account_id_category_item_id_pk" PRIMARY KEY("account_id","category","item_id")
);
