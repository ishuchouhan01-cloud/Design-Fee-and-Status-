CREATE TABLE "import_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"file_type" text NOT NULL,
	"mapping" text DEFAULT '{}' NOT NULL,
	"updated_by_label" text,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_run_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dfs_wbs_nodes" ADD COLUMN "created_import_batch_id" text;--> statement-breakpoint
ALTER TABLE "disciplines" ADD COLUMN "dfs_group" text;--> statement-breakpoint
ALTER TABLE "drawing_import_batches" ADD COLUMN "file_type" text;--> statement-breakpoint
ALTER TABLE "drawing_import_batches" ADD COLUMN "file_names" text;--> statement-breakpoint
ALTER TABLE "drawing_import_batches" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "drawing_import_batches" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawing_import_batches" ADD COLUMN "undone_by_label" text;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD COLUMN "created_import_batch_id" text;--> statement-breakpoint
ALTER TABLE "drawing_snapshots" ADD COLUMN "created_import_batch_id" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "created_import_batch_id" text;--> statement-breakpoint
ALTER TABLE "package_fees" ADD COLUMN "created_import_batch_id" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "created_import_batch_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "parent_project_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "display_order" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_import_batch_id" text;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run_changes" ADD CONSTRAINT "import_run_changes_batch_id_drawing_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."drawing_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_mappings_uq" ON "import_mappings" USING btree ("project_id","file_type");--> statement-breakpoint
CREATE INDEX "import_run_changes_batch_ix" ON "import_run_changes" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_project_id_projects_id_fk" FOREIGN KEY ("parent_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_parent_ix" ON "projects" USING btree ("parent_project_id");