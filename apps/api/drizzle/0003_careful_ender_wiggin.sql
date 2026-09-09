ALTER TABLE "accounts" ADD COLUMN "credentials" jsonb;--> statement-breakpoint
UPDATE "accounts" a
SET "credentials" = jsonb_build_object('creds', wa."value")
FROM "whatsapp_auth" wa
WHERE wa."account_id" = a."account_id"
  AND a."station" = 'whatsapp'
  AND wa."category" = 'creds'
  AND wa."item_id" = '';
