CREATE TABLE "computer_settings" (
	"computer_guid" text PRIMARY KEY NOT NULL,
	"computer_name" text NOT NULL,
	"remove_unmanaged" text,
	"keep_local_printers" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ou_settings" ADD COLUMN "remove_unmanaged" text;--> statement-breakpoint
ALTER TABLE "ou_settings" ADD COLUMN "unmanaged_keep" jsonb;--> statement-breakpoint
ALTER TABLE "ou_settings" ADD COLUMN "keep_local_printers" boolean;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "extra_uuids" jsonb DEFAULT '[]'::jsonb NOT NULL;