CREATE TABLE "accounts" (
	"agent_id" integer NOT NULL,
	"station" text NOT NULL,
	"account_id" text NOT NULL,
	"config" jsonb NOT NULL,
	CONSTRAINT "accounts_station_account_id_pk" PRIMARY KEY("station","account_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keys" (
	"agent_id" integer NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "keys_agent_id_name_pk" PRIMARY KEY("agent_id","name")
);
