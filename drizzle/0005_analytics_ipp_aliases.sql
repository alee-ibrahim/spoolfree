CREATE TABLE "print_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" uuid,
	"computer_guid" text NOT NULL,
	"computer_name" text NOT NULL,
	"ou_dn" text,
	"record_id" bigint NOT NULL,
	"printed_at" timestamp with time zone NOT NULL,
	"user_name" text,
	"user_sid" text,
	"client_computer" text,
	"queue_name" text NOT NULL,
	"printer_id" uuid,
	"port" text,
	"port_host" text,
	"pages" integer,
	"bytes" bigint,
	"document_name" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printer_counter_daily" (
	"printer_id" uuid NOT NULL,
	"day" date NOT NULL,
	"revision" integer NOT NULL,
	"first_count" bigint NOT NULL,
	"last_count" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "printer_counter_daily_printer_id_day_pk" PRIMARY KEY("printer_id","day")
);
--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "ipp_path_auto" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "legacy_aliases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printer_counter_daily" ADD CONSTRAINT "printer_counter_daily_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "print_jobs_event_unique" ON "print_jobs" USING btree ("computer_guid","record_id","printed_at");--> statement-breakpoint
CREATE INDEX "print_jobs_printed_at_idx" ON "print_jobs" USING btree ("printed_at");--> statement-breakpoint
CREATE INDEX "print_jobs_printer_idx" ON "print_jobs" USING btree ("printer_id","printed_at");--> statement-breakpoint
-- Existing printers keep a non-default IPP path as a manual override; the default path is detected by the next Test.
UPDATE "printers" SET "ipp_path_auto" = false WHERE "ipp_path" <> '/ipp/print';
