CREATE TYPE "public"."station" AS ENUM('xmtp', 'telegram', 'telegram-user', 'discord');--> statement-breakpoint
CREATE TABLE "accounts" (
	"agent" text NOT NULL,
	"station" "station" NOT NULL,
	"account_id" text NOT NULL,
	"config" jsonb NOT NULL,
	CONSTRAINT "accounts_station_account_id_pk" PRIMARY KEY("station","account_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"name" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keys" (
	"agent" text NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "keys_agent_name_pk" PRIMARY KEY("agent","name")
);
