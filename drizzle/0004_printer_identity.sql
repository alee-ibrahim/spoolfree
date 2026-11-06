ALTER TABLE "printers" ADD COLUMN "device_uuid" text;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "mac_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "identity_checked_at" timestamp with time zone;