UPDATE "stations"
SET "config" = "config" || jsonb_build_object(
		'dbPath', '~/.metro/xmtp-production-' || "account_id" || '.db3'
	)
WHERE "station" = 'xmtp' AND "config"->>'dbPath' IS NULL;
