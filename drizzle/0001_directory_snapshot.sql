CREATE TABLE "directory_computers" (
	"object_guid" text PRIMARY KEY NOT NULL,
	"dn" text NOT NULL,
	"name" text NOT NULL,
	"dns_host_name" text,
	"operating_system" text,
	"user_account_control" integer NOT NULL,
	"disabled" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_ous" (
	"dn" text PRIMARY KEY NOT NULL,
	"object_guid" text,
	"name" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "directory_sync" (
	"id" integer PRIMARY KEY NOT NULL,
	"base_dn" text,
	"default_container" text,
	"synced_at" timestamp with time zone,
	"source" text,
	"ou_count" integer DEFAULT 0 NOT NULL,
	"computer_count" integer DEFAULT 0 NOT NULL,
	"last_error_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "directory_computers_dn_unique" ON "directory_computers" USING btree (lower("dn"));