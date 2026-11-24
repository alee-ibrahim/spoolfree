CREATE TABLE "printer_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"printer_id" uuid NOT NULL,
	"job_id" integer NOT NULL,
	"created_raw" bigint NOT NULL,
	"name" text,
	"owner" text,
	"state" text NOT NULL,
	"pages" integer,
	"created_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "jobs_unsupported_revision" integer;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "jobs_unsupported_reason" text;--> statement-breakpoint
ALTER TABLE "printer_jobs" ADD CONSTRAINT "printer_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "printer_jobs_job_unique" ON "printer_jobs" USING btree ("printer_id","job_id","created_raw");--> statement-breakpoint
CREATE INDEX "printer_jobs_printer_idx" ON "printer_jobs" USING btree ("printer_id","seen_at");