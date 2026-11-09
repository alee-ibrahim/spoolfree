CREATE TABLE "test_prints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"printer_id" uuid NOT NULL,
	"printer_name" text NOT NULL,
	"mode" text NOT NULL,
	"agent_id" uuid,
	"computer_name" text,
	"computer_guid" text,
	"requested_by" text NOT NULL,
	"state" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"format" text,
	"job_id" integer,
	"job_uri" text,
	"job_status" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "test_prints" ADD CONSTRAINT "test_prints_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_prints" ADD CONSTRAINT "test_prints_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_prints_printer_idx" ON "test_prints" USING btree ("printer_id","created_at");--> statement-breakpoint
CREATE INDEX "test_prints_agent_idx" ON "test_prints" USING btree ("agent_id","state");