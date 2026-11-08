CREATE TABLE "driver_package_chunks" (
	"package_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "driver_package_chunks_package_id_seq_pk" PRIMARY KEY("package_id","seq")
);
--> statement-breakpoint
CREATE TABLE "driver_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"file_name" text,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"architecture" text DEFAULT 'x64' NOT NULL,
	"universal" boolean DEFAULT false NOT NULL,
	"universal_driver" text,
	"manufacturer" text,
	"infs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "driver_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "driver_package_id" uuid;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "driver_name" text;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "vendor_protocol" text DEFAULT 'raw9100' NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "lpr_queue" text;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "auto_vendor_reason" text;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "auto_vendor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "speed_samples" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "speed_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "driver_package_chunks" ADD CONSTRAINT "driver_package_chunks_package_id_driver_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."driver_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "driver_packages_name_unique" ON "driver_packages" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_driver_package_id_driver_packages_id_fk" FOREIGN KEY ("driver_package_id") REFERENCES "public"."driver_packages"("id") ON DELETE restrict ON UPDATE no action;