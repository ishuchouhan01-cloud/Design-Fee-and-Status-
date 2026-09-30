ALTER TABLE "package_fees" ADD COLUMN "billed_to_date_value" double precision;--> statement-breakpoint
ALTER TABLE "package_fees" ADD COLUMN "applicability" text DEFAULT 'APPLICABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_fees" ADD COLUMN "source_workbook" text;--> statement-breakpoint
ALTER TABLE "package_fees" ADD COLUMN "source_sheet" text;--> statement-breakpoint
ALTER TABLE "package_fees" ADD COLUMN "source_row" integer;--> statement-breakpoint
ALTER TABLE "package_fees" ADD COLUMN "user_edited_fields" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_fees" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "source_workbook" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "source_sheet" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "source_row" integer;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "import_batch_id" text;