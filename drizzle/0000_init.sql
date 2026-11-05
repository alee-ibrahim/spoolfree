CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_guid" text NOT NULL,
	"dn" text NOT NULL,
	"computer_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_manifest_at" timestamp with time zone,
	"last_report_at" timestamp with time zone,
	"last_report" jsonb,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "computer_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_guid" text NOT NULL,
	"computer_name" text NOT NULL,
	"printer_id" uuid NOT NULL,
	"action" text NOT NULL,
	"make_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ou_assignments" (
	"ou_dn" text NOT NULL,
	"printer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ou_assignments_ou_dn_printer_id_pk" PRIMARY KEY("ou_dn","printer_id")
);
--> statement-breakpoint
CREATE TABLE "ou_settings" (
	"ou_dn" text PRIMARY KEY NOT NULL,
	"block_inheritance" boolean DEFAULT false NOT NULL,
	"blocked_printer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_printer_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printer_status" (
	"printer_id" uuid PRIMARY KEY NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'unknown' NOT NULL,
	"state_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state_message" text,
	"markers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"page_count" integer,
	"source" text DEFAULT 'none' NOT NULL,
	"error" text,
	"last_seen" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"alert_key" text
);
--> statement-breakpoint
CREATE TABLE "printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 631 NOT NULL,
	"ipp_path" text DEFAULT '/ipp/print' NOT NULL,
	"use_tls" boolean DEFAULT false NOT NULL,
	"location" text,
	"model" text,
	"notes" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computer_overrides" ADD CONSTRAINT "computer_overrides_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ou_assignments" ADD CONSTRAINT "ou_assignments_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ou_settings" ADD CONSTRAINT "ou_settings_default_printer_id_printers_id_fk" FOREIGN KEY ("default_printer_id") REFERENCES "public"."printers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printer_status" ADD CONSTRAINT "printer_status_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_guid_unique" ON "agents" USING btree ("object_guid");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_token_unique" ON "agents" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "computer_overrides_unique" ON "computer_overrides" USING btree ("computer_guid","printer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "printers_name_unique" ON "printers" USING btree (lower("name"));