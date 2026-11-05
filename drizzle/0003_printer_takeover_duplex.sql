ALTER TABLE "printers" ADD COLUMN "legacy_takeover" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "legacy_shares" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "default_sides" text DEFAULT 'auto' NOT NULL;