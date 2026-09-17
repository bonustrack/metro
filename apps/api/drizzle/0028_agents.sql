ALTER TABLE "servers" RENAME TO "agents";
ALTER INDEX "servers_owner_host_idx" RENAME TO "agents_owner_host_idx";
ALTER INDEX "servers_owner_idx" RENAME TO "agents_owner_idx";
