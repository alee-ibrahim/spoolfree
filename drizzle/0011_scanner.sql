ALTER TABLE "printer_status" ADD COLUMN "scanner_state" text;--> statement-breakpoint
ALTER TABLE "printer_status" ADD COLUMN "scanner_adf_state" text;--> statement-breakpoint
ALTER TABLE "printer_status" ADD COLUMN "scanner_error" text;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "scanner" jsonb;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "scanner_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "last_test_scan_at" timestamp with time zone;